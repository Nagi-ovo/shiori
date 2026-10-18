import "../../test/setupDom";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import type { PdfDocument, PdfEngine } from "../../pdf/engine/types";
import type { DocumentModel } from "../../pdf/model/types";

const { exportCompactRasterPdf } = await import("./compactRasterPdf");

const originalCreateElement = document.createElement.bind(document);
let latestCanvas: HTMLCanvasElement;
let blobFailure = false;
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
});

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
  const context = {
    fillStyle: "",
    fillRect: () => undefined,
  } as unknown as CanvasRenderingContext2D;
  return {
    width: 0,
    height: 0,
    getContext: () => context,
    toBlob: (callback: BlobCallback) => {
      callback(blobFailure ? null : new Blob([tinyWhiteJpeg()]));
    },
  } as unknown as HTMLCanvasElement;
}

function tinyWhiteJpeg(): Uint8Array {
  const base64 =
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==";
  const raw = atob(base64);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}
