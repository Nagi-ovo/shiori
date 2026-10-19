import type { PdfCoreBridge } from "../pdfiumEngine";
import type { CoreWorkerReply, CoreWorkerRequest } from "./protocol";

const PRIORITY = { visible: 0, backdrop: 1, thumbnail: 2 } as const;

/**
 * The core worker (./coreWorker.ts) as the PDFium engine reaches it: the
 * same bridge the desktop render thread offers over Tauri IPC. The worker
 * starts on the first open. If it dies, every pending and later request
 * fails with the reason.
 */
export function createWasmCoreBridge(
  startWorker: () => Worker = () =>
    new Worker(new URL("./coreWorker.ts", import.meta.url), { type: "module", name: "shiori-core" }),
): PdfCoreBridge {
  let worker: Worker | null = null;
  let broken: string | null = null;
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();

  const fail = (reason: string) => {
    broken = reason;
    for (const { reject } of pending.values()) reject(reason);
    pending.clear();
  };

  const post = (message: CoreWorkerRequest, transfer: Transferable[] = []) => {
    if (!worker) {
      worker = startWorker();
      worker.onmessage = (event: MessageEvent<CoreWorkerReply>) => {
        const reply = event.data;
        const waiting = pending.get(reply.id);
        if (!waiting) return;
        pending.delete(reply.id);
        if (reply.ok) waiting.resolve(reply.value);
        else waiting.reject(reply.error);
      };
      worker.onerror = (event) => fail(`pdf-core-worker: ${event.message || "failed"}`);
    }
    worker.postMessage(message, transfer);
  };

  const call = <T>(message: CoreWorkerRequest & { id: number }, transfer: Transferable[] = []) =>
    new Promise<T>((resolve, reject) => {
      if (broken) {
        reject(broken);
        return;
      }
      pending.set(message.id, { resolve: resolve as (value: unknown) => void, reject });
      post(message, transfer);
    });

  return {
    open: (bytes, password) => {
      // The caller keeps its bytes (export and the draft store read them
      // too), so a copy is transferred; `bytes.buffer` itself may be shared
      // or larger than the view.
      const copy = bytes.slice().buffer;
      return call<number>({ kind: "open", id: nextId++, bytes: copy, password }, [copy]);
    },
    render: async (doc, page, request, priority, ticket) => {
      const buffer = await call<ArrayBuffer>({
        kind: "render", id: nextId++, ticket, doc, page, priority: PRIORITY[priority], request,
      });
      return new Uint8ClampedArray(buffer);
    },
    cancel: (tickets) => {
      if (worker && tickets.length > 0) post({ kind: "cancel", tickets });
    },
    close: (doc) => {
      if (worker) post({ kind: "close", doc });
    },
    hideAnnotations: (doc, page, keys) =>
      call<number>({ kind: "read", id: nextId++, doc, op: "hideAnnotations", page, keys }),
    outline: (doc) => call({ kind: "read", id: nextId++, doc, op: "outline" }),
    links: (doc, page) => call({ kind: "read", id: nextId++, doc, op: "links", page }),
    pageText: (doc, page) => call({ kind: "read", id: nextId++, doc, op: "pageText", page }),
    pageGeometry: (doc) => call({ kind: "read", id: nextId++, doc, op: "geometry" }),
    pageFonts: async (doc, page) =>
      new Uint8Array(await call<ArrayBuffer>({ kind: "read", id: nextId++, doc, op: "fonts", page })),
    fontOutlines: async (doc, page, names) =>
      new Uint8Array(await call<ArrayBuffer>({ kind: "read", id: nextId++, doc, op: "fontOutlines", page, names })),
    decryptedCopy: async (doc) =>
      new Uint8Array(await call<ArrayBuffer>({ kind: "read", id: nextId++, doc, op: "decryptedCopy" })),
    security: (doc) => call({ kind: "read", id: nextId++, doc, op: "security" }),
    encryptLikeSource: async (doc, plain) => {
      const copy = plain.slice().buffer;
      return new Uint8Array(
        await call<ArrayBuffer>({ kind: "read", id: nextId++, doc, op: "encryptLikeSource", bytes: copy }, [copy]),
      );
    },
  };
}
