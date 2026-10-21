import { describe, expect, test } from "bun:test";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFString,
  type PDFObject,
} from "pdf-lib";
import { exportPdf } from "../export/exportPdf";
import type { Overlay, PageModel } from "../model/types";
import { importFileAnnotations } from "./annotations";

// What an annotation another reader wrote carried beyond its shape, through
// a round trip: imported into overlays, exported again. Export replaces every
// source annotation it imported, so whatever import leaves behind is gone
// from the file for good.

const page: PageModel = { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 300, heightPt: 400 };
const quad = { Rect: [18, 18, 122, 42], QuadPoints: [20, 40, 120, 40, 20, 20, 120, 20] };

async function sourcePdf(annots: Record<string, unknown>[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const pdfPage = pdf.addPage([300, 400]);
  const refs: PDFObject[] = annots.map((entries) =>
    pdf.context.register(pdf.context.obj({ Type: "Annot", ...entries } as never)),
  );
  pdfPage.node.set(PDFName.of("Annots"), pdf.context.obj(refs as never) as PDFArray);
  return pdf.save({ useObjectStreams: false });
}

async function roundTrip(annots: Record<string, unknown>[]) {
  const bytes = await sourcePdf(annots);
  const overlays: Overlay[] = await importFileAnnotations([page], bytes, 1);
  const out = await exportPdf(bytes, { pages: [page], overlays });
  const loaded = await PDFDocument.load(out.bytes);
  const list = loaded.getPage(0).node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  const exported: PDFDict[] = [];
  for (let i = 0; i < (list?.size() ?? 0); i++) {
    const dict = loaded.context.lookupMaybe(list!.get(i), PDFDict);
    if (dict) exported.push(dict);
  }
  return { overlays, exported };
}

function text(dict: PDFDict, key: string): string | undefined {
  return dict.lookupMaybe(PDFName.of(key), PDFString, PDFHexString)?.decodeText();
}

describe("a comment on a markup, square or ink", () => {
  const comment = PDFHexString.fromText("Zotero comment: 重要");

  test.each([
    { Subtype: "Highlight", ...quad },
    { Subtype: "Underline", ...quad },
    { Subtype: "StrikeOut", ...quad },
    { Subtype: "Square", Rect: [20, 20, 120, 100], BS: { W: 2 } },
    { Subtype: "Ink", Rect: [10, 100, 60, 150], InkList: [[12, 102, 30, 140]] },
  ])("comes back from a $Subtype's /Contents", async (annot) => {
    const { overlays, exported } = await roundTrip([{ ...annot, Contents: comment }]);
    expect(overlays).toMatchObject([{ comment: "Zotero comment: 重要" }]);
    expect(text(exported[0]!, "Contents")).toBe("Zotero comment: 重要");
  });

  test("is not invented when /Contents is empty", async () => {
    const { overlays } = await roundTrip([{ Subtype: "Highlight", ...quad, Contents: PDFString.of("") }]);
    expect(overlays[0]).not.toHaveProperty("comment");
  });
});

describe("a hidden annotation", () => {
  // Hidden (2) | Print (4): how review-state markers are written.
  test("is neither imported nor replaced, so it stays hidden", async () => {
    const { overlays, exported } = await roundTrip([
      { Subtype: "Text", F: 6, Rect: [40, 300, 60, 320], Contents: PDFString.of("Accepted") },
      { Subtype: "Highlight", F: 2, ...quad },
    ]);
    expect(overlays).toEqual([]);
    expect(exported.map((dict) => [text(dict, "Contents"), dict.get(PDFName.of("F"))?.toString()])).toEqual([
      ["Accepted", "6"],
      [undefined, "2"],
    ]);
  });
});
