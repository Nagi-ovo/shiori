/// <reference lib="webworker" />
import { loadWasmCore, type WasmCore } from "./loadCore";
import type { CoreWorkerReply, CoreWorkerRequest } from "./protocol";
import { RenderQueue } from "./renderQueue";

/**
 * shiori-core in a web worker: the web and mobile builds' PDFium
 * (docs/PLAN-RUST-PDF-CORE-2026-09.md, 4.6). Opening, reading and hiding run
 * as they arrive; renders queue by priority and yield between regions, so a
 * tile on screen overtakes thumbnails and a scroll's cancels land in time.
 *
 * The CJK fallback fonts are lazy files: PDFium sees them in its font folder,
 * and only the ranges it reads are fetched, when a document names a CJK font
 * it does not embed.
 */
declare const self: DedicatedWorkerGlobalScope;

type RenderJob = Extract<CoreWorkerRequest, { kind: "render" }>;
type Doc = WasmCore["CoreDocument"]["prototype"];

const ready: Promise<WasmCore> = loadWasmCore({
  pdfium: new URL("./generated/pdfium.wasm", import.meta.url).href,
  core: new URL("./generated/shiori_core_wasm_bg.wasm", import.meta.url).href,
  fonts: [
    { file: "NotoSansSC-Regular.otf", url: new URL("../../../assets/fonts/NotoSansSC-Regular.otf", import.meta.url).href },
    { file: "NotoSansJP-Regular.otf", url: new URL("../../../assets/fonts/NotoSansJP-Regular.otf", import.meta.url).href },
  ],
});
// A failed load answers every request with its reason, and the engine draws
// with pdf.js instead.
ready.catch(() => undefined);

const docs = new Map<number, Doc>();
let nextDoc = 1;
const queue = new RenderQueue<RenderJob>();
let pumping = false;
// Yields between regions through a message, which runs next in the event
// loop; nested setTimeout(0) is clamped to 4 ms, idling ~120 ms over 30 tiles.
const yielder = new MessageChannel();
yielder.port1.onmessage = () => pump();
const yieldThenPump = () => yielder.port2.postMessage(null);

function reply(message: CoreWorkerReply, transfer: Transferable[] = []): void {
  self.postMessage(message, transfer);
}

function fail(id: number, error: unknown): void {
  reply({ kind: "reply", id, ok: false, error: error instanceof Error ? error.message : String(error) });
}

function docOf(id: number): Doc {
  const doc = docs.get(id);
  if (!doc) throw new Error("pdf-core-closed");
  return doc;
}

function read(core: WasmCore, message: Extract<CoreWorkerRequest, { kind: "read" }>): unknown {
  const doc = docOf(message.doc);
  switch (message.op) {
    case "pageText":
      return JSON.parse(doc.pageText(message.page!));
    case "outline":
      return JSON.parse(doc.outline());
    case "links":
      return JSON.parse(doc.links(message.page!));
    case "hideAnnotations":
      return doc.hideAnnotations(message.page!, JSON.stringify(message.keys ?? []));
    case "decryptedCopy":
      return core.decryptedCopy(doc).buffer;
    case "security":
      return core.security(doc);
    case "encryptLikeSource":
      return doc.encryptLikeSource(new Uint8Array(message.bytes!)).buffer;
    case "fonts":
      return doc.embeddedFonts(message.page!).buffer;
    case "fontOutlines":
      return doc.fontOutlines(message.page!, JSON.stringify(message.names ?? [])).buffer;
    case "geometry":
      return Array.from({ length: doc.pageCount() }, (_, index) => JSON.parse(doc.pageGeometry(index)));
  }
}

/** Draws one queued region, then gives the event loop a turn before the next. */
function pump(): void {
  const next = queue.take();
  if (!next) {
    pumping = false;
    return;
  }
  const { job, cancelled } = next;
  if (cancelled) {
    fail(job.id, "cancelled");
  } else {
    try {
      const { rotation, pixelsPerPoint, x, y, width, height, annotations } = job.request;
      const rgba = docOf(job.doc).render(job.page, rotation, pixelsPerPoint, x, y, width, height, annotations ?? true);
      reply({ kind: "reply", id: job.id, ok: true, value: rgba.buffer }, [rgba.buffer]);
    } catch (error) {
      fail(job.id, error);
    }
  }
  yieldThenPump();
}

self.onmessage = async (event: MessageEvent<CoreWorkerRequest>) => {
  const message = event.data;
  if (message.kind === "cancel") {
    queue.cancel(message.tickets);
    return;
  }
  let core: WasmCore;
  try {
    core = await ready;
  } catch (error) {
    if ("id" in message) fail(message.id, error);
    return;
  }
  switch (message.kind) {
    case "open":
      try {
        const doc = core.CoreDocument.open(new Uint8Array(message.bytes), message.password);
        const id = nextDoc++;
        docs.set(id, doc);
        reply({ kind: "reply", id: message.id, ok: true, value: id });
      } catch (error) {
        fail(message.id, error);
      }
      return;
    case "close":
      docs.get(message.doc)?.free();
      docs.delete(message.doc);
      return;
    case "read":
      try {
        const value = read(core, message);
        reply({ kind: "reply", id: message.id, ok: true, value }, value instanceof ArrayBuffer ? [value] : []);
      } catch (error) {
        fail(message.id, error);
      }
      return;
    case "render":
      queue.push(message);
      if (!pumping) {
        pumping = true;
        yieldThenPump();
      }
      return;
  }
};
