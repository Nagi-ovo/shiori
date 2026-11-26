import "../../test/setupDom";
import { beforeEach, describe, expect, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import type { PdfDocument } from "../../pdf/engine/types";
import type { ContentTextOverlay, Overlay, PageModel, TextFlowChain } from "../../pdf/model/types";
import { readFileSync } from "node:fs";
import { buildFlow } from "../../pdf/export/contentText/flow/linkedFlow.test-support";
import { fakePdfDocument, withFakePdfEngine } from "../../test/fakePdfEngine";
import { fixture, overlay } from "../../pdf/export/contentText/fixtures.test-support";
import { inspectRunPage } from "../../pdf/export/contentStreamEdit/replaceRunPage";
import { paintThumbnail } from "./thumbnailPaint";

// Ways a page tile can misreport an edit of the page's own text:
// - it paints a filled box (white, sampled or any color) over the source
//   glyphs, hiding the artwork underneath;
// - it prints the replacement on top of the old glyphs (double print);
// - it shows a refused or unavailable edit as if it had been written;
// - it renders the wrong page/source index or drops the page rotation;
// - it loses the other overlays drawn on top of the page;
// - it keeps the preview document open after painting or after cancel;
// - a superseded paint (rapid typing, undo) still lands on the tile;
// - it writes into the opened document's bytes;
// - a page with no such edit, or a blank page, pays for a preview it never
//   shows;
// - a preview that resolves after Undo or a document switch (the caller's
//   cancel) still renders or paints over the tile.

const STRIPE = "0.9 0.2 0.2 rg 40 95 120 20 re f 0 g";
const STRIPE_COLOR = "#e63333";
const page: PageModel = { id: "p", sourceIndex: 0, widthPt: 300, heightPt: 200, rotation: 0 };

type Render = { doc: PdfDocument; sourceIndex: number; rotation: number };
let renders: Render[] = [];
let loaded = new Map<PdfDocument, Uint8Array>();
let destroyed: PdfDocument[] = [];
let calls: Array<{ name: string; args: unknown[]; fillStyle: unknown }> = [];
let loadGate: Promise<void> | null = null;
let renderGate: Promise<void> | null = null;
const sourceDoc = fakePdfDocument();

withFakePdfEngine(() => ({
  load: async (bytes: Uint8Array) => {
    await loadGate;
    const doc = fakePdfDocument();
    loaded.set(doc, bytes);
    return { doc, bytes };
  },
  renderRegion: (doc, request, canvas) => {
    if (request.priority === "thumbnail") {
      renders.push({ doc, sourceIndex: request.sourceIndex, rotation: request.rotation });
      return { cancel: () => undefined, done: renderGate ?? Promise.resolve() };
    }
    // Contact probes use disposable canvases. Give them valid pixels while
    // recording which document actually reaches the thumbnail.
    const { width, height } = request.region;
    Object.defineProperty(canvas, "getContext", {
      value: () => ({ getImageData: () => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) }),
    });
    return { cancel: () => undefined, done: Promise.resolve() };
  },
  destroy: async (doc) => {
    if (doc) destroyed.push(doc);
  },
}));

let sourceBytes: Uint8Array;

beforeEach(async () => {
  renders = [];
  loaded = new Map();
  destroyed = [];
  calls = [];
  loadGate = null;
  renderGate = null;
  const { doc } = await fixture(`${STRIPE} BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET`);
  sourceBytes = await doc.save();
});

function edit(patch: Partial<ContentTextOverlay> = {}): ContentTextOverlay {
  return overlay({ backgroundColor: STRIPE_COLOR, ...patch });
}

function recordingCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 168;
  canvas.height = 112;
  const state: Record<string, unknown> = { canvas };
  const ctx = new Proxy(state, {
    get: (target, key) => {
      if (key in target) return target[key as string];
      return (...args: unknown[]) => {
        calls.push({ name: String(key), args, fillStyle: target.fillStyle });
        return key === "measureText" ? { width: String(args[0]).length * 4 } : undefined;
      };
    },
    set: (target, key, value) => {
      target[key as string] = value;
      return true;
    },
  });
  (canvas as unknown as { getContext: () => unknown }).getContext = () => ctx;
  return canvas;
}

async function paint(
  overlays: Overlay[],
  options: { page?: PageModel; cancelled?: () => boolean; source?: Uint8Array | null; flowChains?: TextFlowChain[] } = {},
) {
  const canvas = recordingCanvas();
  const painted = await paintThumbnail({
    canvas: () => canvas,
    doc: sourceDoc,
    sourceBytes: options.source === undefined ? sourceBytes : options.source,
    page: options.page ?? page,
    overlays,
    flowChains: options.flowChains,
    paperColor: null,
    cancelled: options.cancelled ?? (() => false),
    onBackdrop: () => undefined,
  });
  return painted;
}

async function contentOf(bytes: Uint8Array): Promise<string> {
  const inspected = inspectRunPage((await PDFDocument.load(bytes)).getPage(0));
  if (!inspected.ok) throw new Error("preview page content unreadable");
  return new TextDecoder().decode(inspected.bytes);
}

function previewRenders(): Render[] {
  return renders.filter((render) => render.doc !== sourceDoc);
}

function expectNoCanvasCoverOrText() {
  expect(calls.filter((call) => call.name === "fillRect")).toEqual([]);
  expect(calls.filter((call) => call.name === "fillText")).toEqual([]);
}

function expectLoadedDocumentsReleased() {
  expect(destroyed).toHaveLength(loaded.size);
  expect(new Set(destroyed)).toEqual(new Set(loaded.keys()));
}

describe("page tile with an edit of the page's own text", () => {
  test("an accepted change shows the written page: stripe kept, old glyphs gone, no cover", async () => {
    const before = sourceBytes.slice();
    expect(await paint([edit()])).toBe(true);

    expect(renders).toHaveLength(1);
    const [render] = previewRenders();
    expect(render).toMatchObject({ sourceIndex: 0, rotation: 0 });
    const written = await contentOf(loaded.get(render!.doc)!);
    expect(written).toContain(STRIPE);
    expect(written).toContain("<58>");
    expect(written).not.toContain("(ABCDE)");
    expectNoCanvasCoverOrText();
    expectLoadedDocumentsReleased();
    expect(sourceBytes).toEqual(before);
  });

  test("an accepted deletion shows the stripe with the glyphs removed", async () => {
    expect(await paint([edit({ text: "" })])).toBe(true);

    const [render] = previewRenders();
    const written = await contentOf(loaded.get(render!.doc)!);
    expect(written).toContain(STRIPE);
    expect(written).not.toContain("ABCDE");
    expectNoCanvasCoverOrText();
  });

  test("a refused edit shows the genuine source page and nothing over it", async () => {
    expect(await paint([edit({ originalText: "ZZZZZ" })])).toBe(true);

    expect(renders).toEqual([{ doc: sourceDoc, sourceIndex: 0, rotation: 0 }]);
    expectNoCanvasCoverOrText();
  });

  test("an unavailable preview falls back to the source page without a cover", async () => {
    expect(await paint([edit()], { source: new Uint8Array([1, 2, 3]) })).toBe(true);
    expect(renders).toEqual([{ doc: sourceDoc, sourceIndex: 0, rotation: 0 }]);
    expectNoCanvasCoverOrText();

    renders = [];
    calls = [];
    expect(await paint([edit()], { source: null })).toBe(true);

    expect(renders).toEqual([{ doc: sourceDoc, sourceIndex: 0, rotation: 0 }]);
    expectNoCanvasCoverOrText();
  });

  test("keeps the page rotation and still paints the other overlays", async () => {
    const box: Overlay = {
      type: "rect", id: "box", pageId: "p", rect: { x: 10, y: 10, w: 40, h: 20 },
      color: "#0000ff", strokeWidth: 2, fill: "#00ff00",
    };
    expect(await paint([edit(), box], { page: { ...page, rotation: 90 } })).toBe(true);

    expect(previewRenders()).toMatchObject([{ sourceIndex: 0, rotation: 90 }]);
    expect(calls.some((call) => call.name === "fill" && call.fillStyle === "#00ff00")).toBe(true);
    expect(calls.some((call) => call.fillStyle === STRIPE_COLOR)).toBe(false);
  });

  test("a superseded paint never reaches the tile and releases its preview", async () => {
    let firstCancelled = false;
    const first = paint([edit({ text: "AXCDE" })], { cancelled: () => firstCancelled });
    firstCancelled = true;
    const second = paint([edit({ text: "AYCDE" })]);
    expect(await first).toBe(false);
    expect(await second).toBe(true);

    const shown = previewRenders();
    expect(shown).toHaveLength(1);
    expect(await contentOf(loaded.get(shown[0]!.doc)!)).toContain("<59>");
    expectLoadedDocumentsReleased();
  });

  test("undoing the edit shows the source page again", async () => {
    await paint([edit()]);
    renders = [];
    expect(await paint([])).toBe(true);

    expect(renders).toEqual([{ doc: sourceDoc, sourceIndex: 0, rotation: 0 }]);
  });

  test("a page without a content edit renders its source page and builds no preview", async () => {
    const box: Overlay = {
      type: "rect", id: "box", pageId: "p", rect: { x: 10, y: 10, w: 40, h: 20 },
      color: "#0000ff", strokeWidth: 2,
    };
    expect(await paint([box])).toBe(true);

    expect(loaded.size).toBe(0);
    expect(renders).toEqual([{ doc: sourceDoc, sourceIndex: 0, rotation: 0 }]);
    expect(calls.some((call) => call.name === "stroke")).toBe(true);
  });

  test("a blank page shows paper only: no preview, no render, no cover", async () => {
    const blank: PageModel = { ...page, id: "b", sourceIndex: -1, blank: true };
    expect(await paint([edit({ pageId: "b" })], { page: blank })).toBe(true);

    expect(loaded.size).toBe(0);
    expect(renders).toEqual([]);
    const fills = calls.filter((call) => call.name === "fillRect");
    expect(fills.map((call) => call.fillStyle)).toEqual(["#fffdf8"]);
    expect(calls.filter((call) => call.name === "fillText")).toEqual([]);
  });

  test("an edit on a later source page writes that page and leaves the source index behind", async () => {
    const out = await PDFDocument.create();
    out.addPage([300, 200]);
    out.addPage([300, 200]);
    const [copied] = await out.copyPages(await PDFDocument.load(sourceBytes), [0]);
    out.addPage(copied);
    const later = { ...page, sourceIndex: 2 };
    const source = await out.save();

    expect(await paint([edit()], { page: later, source })).toBe(true);
    const [render] = previewRenders();
    expect(render).toMatchObject({ sourceIndex: 0 });
    const written = await contentOf(loaded.get(render!.doc)!);
    expect(written).toContain(STRIPE);
    expect(written).toContain("<58>");

    renders = [];
    expect(await paint([edit({ originalText: "ZZZZZ" })], { page: later, source })).toBe(true);
    expect(renders).toEqual([{ doc: sourceDoc, sourceIndex: 2, rotation: 0 }]);
  });

  test("a preview that opens after the caller cancelled is released, never rendered", async () => {
    let release!: () => void;
    loadGate = new Promise((resolve) => (release = resolve));
    let cancelled = false;
    const late = paint([edit()], { cancelled: () => cancelled });
    await new Promise((resolve) => setTimeout(resolve, 50));
    cancelled = true; // Undo, or the tab switched to another document.
    release();

    expect(await late).toBe(false);
    expect(renders).toEqual([]);
    expect(await contentOf([...loaded.values()].at(-1)!)).toContain("<58>");
    expectLoadedDocumentsReleased();
    expect(calls).toEqual([]);
  });

  test("a page render that finishes after cancel paints nothing over it", async () => {
    let finish!: () => void;
    renderGate = new Promise((resolve) => (finish = resolve));
    let cancelled = false;
    const box: Overlay = {
      type: "rect", id: "box", pageId: "p", rect: { x: 10, y: 10, w: 40, h: 20 },
      color: "#0000ff", strokeWidth: 2,
    };
    const late = paint([edit(), box], { cancelled: () => cancelled });
    while (renders.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    cancelled = true;
    finish();

    expect(await late).toBe(false);
    expect(calls).toEqual([]);
    expectLoadedDocumentsReleased();
  });
});

describe("page tile with a linked-frame edit", () => {
  const linked = () => buildFlow({
    first: ["The lift to the archive floor is out of service", "until the new motor arrives later this month."],
    second: ["Use the east stair meanwhile."],
    edit: "The lift to the archive floor is out of service until the new motor arrives later this month. Boxes heavier than ten kilos go up on the goods hoist by the loading bay.",
  }, (path) => readFileSync(path));

  test("shows the flowed page when the tile is given the chain", async () => {
    const f = await linked();
    expect(await paint(f.model.overlays, { page: f.model.pages[0], source: f.bytes, flowChains: f.model.flowChains })).toBe(true);
    expect(previewRenders()).toHaveLength(1);
  });

  test("without the chain the refused edit leaves the source page on the tile", async () => {
    const f = await linked();
    expect(await paint(f.model.overlays, { page: f.model.pages[0], source: f.bytes })).toBe(true);
    expect(previewRenders()).toEqual([]);
  });
});
