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

describe("an annotation's flags and a note's state", () => {
  const flags = (dict: PDFDict) => dict.get(PDFName.of("F"))?.toString();

  test("come back as written", async () => {
    const { exported } = await roundTrip([
      // Locked | Print, and Locked alone: a mark that never printed.
      { Subtype: "Highlight", F: 132, ...quad },
      { Subtype: "Square", F: 128, Rect: [20, 20, 120, 100] },
      {
        Subtype: "Text", F: 4, Rect: [40, 300, 60, 320], Contents: PDFString.of("Fine"),
        Name: "Key", Open: true, State: PDFString.of("Accepted"), StateModel: PDFString.of("Review"),
      },
    ]);
    expect(exported.map(flags)).toEqual(["132", "128", "4"]);
    const note = exported[2]!;
    expect(note.get(PDFName.of("Name"))?.toString()).toBe("/Key");
    expect(note.get(PDFName.of("Open"))?.toString()).toBe("true");
    expect([text(note, "State"), text(note, "StateModel")]).toEqual(["Accepted", "Review"]);
  });

  // No /F means 0: a viewer shows it but never prints it. Exported with
  // Shiori's own Print it would start printing.
  test("an annotation without /F still does not print", async () => {
    const { exported } = await roundTrip([{ Subtype: "Highlight", ...quad }]);
    expect(flags(exported[0]!)).toBe("0");
  });
});

describe("an ink or square's opacity", () => {
  const ca = (dict: PDFDict) => dict.get(PDFName.of("CA"))?.toString();

  test("comes back from its /CA", async () => {
    const { overlays, exported } = await roundTrip([
      // A highlighter pen, and a filled box that must not hide the text under it.
      { Subtype: "Ink", Rect: [10, 100, 60, 150], CA: 0.4, BS: { W: 8 }, InkList: [[12, 102, 30, 140]] },
      { Subtype: "Square", Rect: [20, 20, 120, 100], CA: 0.3, IC: [1, 1, 0] },
      { Subtype: "Square", Rect: [20, 200, 120, 280] },
    ]);
    expect(overlays).toMatchObject([{ type: "ink", opacity: 0.4 }, { type: "rect", opacity: 0.3 }, { type: "rect" }]);
    expect(overlays[2]).not.toHaveProperty("opacity");
    expect(exported.map(ca)).toEqual(["0.4", "0.3", undefined]);
  });
});

describe("a text box's fill, border and opacity", () => {
  test("come back from its /C, /BS and /CA", async () => {
    const { overlays, exported } = await roundTrip([{
      Subtype: "FreeText", Rect: [20, 20, 220, 60], DA: PDFString.of("/Helv 12 Tf 0 0 1 rg"),
      Contents: PDFString.of("Boxed"), C: [1, 1, 0.6], BS: { W: 2 }, CA: 0.6,
    }]);
    expect(overlays).toMatchObject([{ type: "text", color: "#0000ff", fill: "#ffff99", borderWidth: 2, opacity: 0.6 }]);
    const [box] = exported;
    expect(box!.get(PDFName.of("C"))?.toString()).toBe("[ 1 1 0.6 ]");
    expect(box!.get(PDFName.of("CA"))?.toString()).toBe("0.6");
  });

  test("a box Shiori exported reopens with its text colour, not its fill", async () => {
    const box: Overlay = {
      type: "text", id: "t", pageId: "p1", rect: { x: 20, y: 20, w: 200, h: 40 }, text: "Boxed",
      fontSize: 12, color: "#0000ff", bold: false, align: "left", fontFamily: "sans",
      fill: "#ffff99", borderWidth: 2, opacity: 0.6,
    };
    const blank = await PDFDocument.create();
    blank.addPage([300, 400]);
    const { bytes } = await exportPdf(await blank.save(), { pages: [page], overlays: [box] });
    const [back] = await importFileAnnotations([page], bytes, 1);
    expect(back).toMatchObject({ color: "#0000ff", fill: "#ffff99", borderWidth: 2, opacity: 0.6 });
  });

  test("a plain box gets none of them", async () => {
    const { overlays } = await roundTrip([{
      Subtype: "FreeText", Rect: [20, 20, 220, 60], DA: PDFString.of("/Helv 12 Tf 0 g"), Contents: PDFString.of("Plain"),
    }]);
    for (const key of ["fill", "borderWidth", "opacity"]) expect(overlays[0]).not.toHaveProperty(key);
  });
});
