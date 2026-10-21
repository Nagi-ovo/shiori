import { describe, expect, test } from "bun:test";
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
} from "pdf-lib";
import { exportPdf } from "./exportPdf";
import type { DocumentModel, Overlay } from "../model/types";

// A translucent ink stroke or box (an imported /CA) burned into the page
// keeps its opacity, as the editable export and the screen show it.

const page = { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 } as const;

/** The stroke (CA) and fill (ca) alpha of every graphics state the page content sets. */
async function alphasSet(overlay: Overlay): Promise<Array<{ CA?: number; ca?: number }>> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  const model = { pages: [page], overlays: [overlay] } as unknown as DocumentModel;
  const { bytes } = await exportPdf(await doc.save(), model, { mode: "flatten" });
  const out = await PDFDocument.load(bytes);
  const node = out.getPage(0).node;
  const contents = node.lookup(PDFName.of("Contents"));
  const streams = contents instanceof PDFArray
    ? Array.from({ length: contents.size() }, (_, i) => contents.lookup(i, PDFRawStream))
    : [contents as PDFRawStream];
  const ops = streams.map((s) => new TextDecoder().decode(decodePDFRawStream(s).decode())).join("\n");
  const states = node.Resources()?.lookupMaybe(PDFName.of("ExtGState"), PDFDict);
  const alpha = (gs: PDFDict | undefined, key: string) =>
    gs?.lookupMaybe(PDFName.of(key), PDFNumber)?.asNumber();
  return [...ops.matchAll(/\/(\S+) gs/g)].map(([, name]) => {
    const gs = states?.lookupMaybe(PDFName.of(name!), PDFDict);
    return { CA: alpha(gs, "CA"), ca: alpha(gs, "ca") };
  });
}

const ink = {
  type: "ink", id: "i", pageId: "p1", color: "#f4d674", width: 8,
  paths: [[{ x: 72, y: 600 }, { x: 200, y: 620 }]],
} as Overlay;
const box = {
  type: "rect", id: "r", pageId: "p1", rect: { x: 72, y: 500, w: 100, h: 50 },
  color: "#b13a2e", strokeWidth: 2, fill: "#ffff00",
} as Overlay;

describe("a flattened ink stroke or box", () => {
  test("strokes an ink at its opacity", async () => {
    expect(await alphasSet({ ...ink, opacity: 0.4 } as Overlay)).toContainEqual(
      expect.objectContaining({ CA: 0.4 }),
    );
  });

  test("strokes and fills a box at its opacity", async () => {
    expect(await alphasSet({ ...box, opacity: 0.3 } as Overlay)).toContainEqual({ CA: 0.3, ca: 0.3 });
  });

  test("stays opaque when made in Shiori", async () => {
    for (const overlay of [ink, box]) {
      for (const state of await alphasSet(overlay)) {
        expect(state.CA ?? 1).toBe(1);
        expect(state.ca ?? 1).toBe(1);
      }
    }
  });
});
