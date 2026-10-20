import "../../test/setupDom";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import type { PdfDocument, PdfEngine } from "../../pdf/engine/types";
import type { DocumentModel } from "../../pdf/model/types";

const { exportCompactRasterPdf } = await import("./compactRasterPdf");

const originalCreateElement = document.createElement.bind(document);
let latestCanvas: HTMLCanvasElement;
let blobFailure = false;
/** Every 2D call the export made, in order: what lands in the page's JPEG. */
let drawCalls: Array<{ name: string; args: unknown[] }> = [];
const doc = {} as PdfDocument;

type RenderRequest = Parameters<PdfEngine["renderRegion"]>[1];

/** An engine whose page renders resolve or fail as told, recording requests. */
function engine(done: Promise<void> = Promise.resolve()) {
  const requests: RenderRequest[] = [];
  const renderRegion = mock((_doc: PdfDocument, request: RenderRequest) => {
    requests.push(request);
    return { cancel: () => undefined, done };
  });
  return { requests, engine: { renderRegion } as Pick<PdfEngine, "renderRegion">, renderRegion };
}

describe("compact raster export canvas lifecycle", () => {
  beforeEach(() => {
    blobFailure = false;
    drawCalls = [];
    document.createElement = ((tagName: string) => {
      if (tagName !== "canvas") return originalCreateElement(tagName);
      latestCanvas = makeCanvas();
      return latestCanvas;
    }) as typeof document.createElement;
  });

  afterEach(() => {
    document.createElement = originalCreateElement;
  });

  test("releases each canvas after a successful page export", async () => {
    const bytes = await exportCompactRasterPdf(doc, modelForPage({ sourceIndex: 0 }), { mode: "none" }, engine().engine);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
    expect([latestCanvas.width, latestCanvas.height]).toEqual([0, 0]);
  });

  test("releases the canvas when the page fails to draw, and reports why", async () => {
    const failure = new Error("render failed");
    const rejected = Promise.reject(failure);
    rejected.catch(() => undefined);
    await expect(
      exportCompactRasterPdf(doc, modelForPage({ sourceIndex: 0 }), { mode: "none" }, engine(rejected).engine),
    ).rejects.toBe(failure);
    expect([latestCanvas.width, latestCanvas.height]).toEqual([0, 0]);
  });

  test("releases the canvas without replacing a JPEG error", async () => {
    blobFailure = true;
    await expect(
      exportCompactRasterPdf(doc, modelForPage({ sourceIndex: 0 }), { mode: "none" }, engine().engine),
    ).rejects.toThrow("Unable to encode compact PDF page.");
    expect([latestCanvas.width, latestCanvas.height]).toEqual([0, 0]);
  });

  test("does not draw a source page for a blank page", async () => {
    const fake = engine();
    const bytes = await exportCompactRasterPdf(
      doc,
      modelForPage({ blank: true, sourceIndex: -1 }),
      { mode: "none" },
      fake.engine,
    );
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
    expect(fake.renderRegion).not.toHaveBeenCalled();
  });

  test("draws the whole page, and the source's annotations only when overlays go too", async () => {
    const fake = engine();
    await exportCompactRasterPdf(doc, modelForPage({ sourceIndex: 2, rotation: 90 }), { mode: "none" }, fake.engine);
    await exportCompactRasterPdf(doc, modelForPage({ sourceIndex: 2, rotation: 90 }), { mode: "annotations" }, fake.engine);
    // A 72 pt page at 120 dpi: 120 × 120 device pixels, turned with the page.
    expect(fake.requests.map((r) => [r.sourceIndex, r.rotation, r.region, r.annotations])).toEqual([
      [2, 90, { x: 0, y: 0, width: 120, height: 120 }, false],
      [2, 90, { x: 0, y: 0, width: 120, height: 120 }, true],
    ]);
  });

  // A placed signature is an image overlay; the raster usually wins on size,
  // so a signature missing here is missing from the exported file.
  test("paints image overlays, signatures included, where they sit on the page", async () => {
    const model = modelForPage({ sourceIndex: 0 });
    model.overlays = [signature()];
    await exportCompactRasterPdf(doc, model, { mode: "annotations" }, engine().engine);

    const drawn = drawCalls.filter((call) => call.name === "drawImage");
    expect(drawn).toHaveLength(1);
    expect((drawn[0]!.args[0] as HTMLImageElement).src).toBe(signature().dataUrl);
    // 36 × 24 pt at 120 dpi, centered on the rect's center (30, 30) pt.
    expect(drawn[0]!.args.slice(1)).toEqual([-30, -20, 60, 40]);
    const center = drawCalls.find((call) => call.name === "translate");
    expect(center?.args).toEqual([50, 70]);
  });

  // The dialog falls back to the standard copy when the raster fails, and
  // that copy embeds the image itself: better than a raster without it.
  test("fails instead of exporting without an image it cannot decode", async () => {
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = () => Promise.reject(new Error("bad image"));
    try {
      const model = modelForPage({ sourceIndex: 0 });
      model.overlays = [signature()];
      await expect(
        exportCompactRasterPdf(doc, model, { mode: "annotations" }, engine().engine),
      ).rejects.toThrow("bad image");
    } finally {
      HTMLImageElement.prototype.decode = decode;
    }
  });
});

function signature(): DocumentModel["overlays"][number] {
  return {
    type: "image",
    id: "signature-1",
    pageId: "page-1",
    rect: { x: 12, y: 18, w: 36, h: 24 },
    dataUrl:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    mimeType: "image/png",
    source: "signature",
  };
}

function modelForPage(
  overrides: Partial<DocumentModel["pages"][number]>,
): DocumentModel {
  return {
    pages: [
      {
        id: "page-1",
        sourceIndex: 0,
        rotation: 0,
        widthPt: 72,
        heightPt: 72,
        ...overrides,
      },
    ],
    overlays: [],
  };
}

function makeCanvas(): HTMLCanvasElement {
  const state: Record<string | symbol, unknown> = {};
  // Properties are kept, every method call is recorded.
  const context = new Proxy(state, {
    get: (target, key) =>
      key in target
        ? target[key]
        : (...args: unknown[]) => {
            drawCalls.push({ name: String(key), args });
          },
    set: (target, key, value) => {
      target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context,
    toBlob: (callback: BlobCallback) => {
      callback(blobFailure ? null : new Blob([tinyWhiteJpeg()]));
    },
  } as unknown as HTMLCanvasElement;
  state.canvas = canvas;
  return canvas;
}

function tinyWhiteJpeg(): Uint8Array {
  const base64 =
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==";
  const raw = atob(base64);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}
