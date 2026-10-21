import { describe, expect, test } from "bun:test";
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFString,
} from "pdf-lib";
import { exportPdf } from "./exportPdf";
import type { DocumentModel, Overlay } from "../model/types";

// What an imported annotation carried beyond its shape, written back on
// export. Export replaces every source annotation it owns, so a field the
// overlay holds but the builder ignores is gone from the file for good.

const page = { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 } as const;
const rects = [{ x: 72, y: 600, w: 200, h: 14 }];

async function exportedAnnotations(overlays: Overlay[]): Promise<PDFDict[]> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  const model = { pages: [page], overlays } as unknown as DocumentModel;
  const { bytes } = await exportPdf(await doc.save(), model);
  const loaded = await PDFDocument.load(bytes);
  const annots = loaded.getPage(0).node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  const out: PDFDict[] = [];
  for (let i = 0; i < (annots?.size() ?? 0); i++) {
    const dict = loaded.context.lookupMaybe(annots!.get(i), PDFDict);
    if (dict) out.push(dict);
  }
  return out;
}

function text(dict: PDFDict, key: string): string | undefined {
  return dict.lookupMaybe(PDFName.of(key), PDFString, PDFHexString)?.decodeText();
}

describe("an annotation's comment survives export", () => {
  const comment = "Zotero comment: 重要";

  test.each([
    { type: "highlight", rects, color: "#f4d674", opacity: 0.4 },
    { type: "underline", rects, color: "#b13a2e", opacity: 1 },
    { type: "strikethrough", rects, color: "#b13a2e", opacity: 1 },
    { type: "rect", rect: rects[0], color: "#b13a2e", strokeWidth: 2, fill: null },
    { type: "ink", paths: [[{ x: 72, y: 600 }, { x: 140, y: 640 }]], color: "#b13a2e", width: 2 },
  ])("on a $type", async (shape) => {
    const [annot] = await exportedAnnotations([
      { ...shape, id: "a", pageId: "p1", comment } as unknown as Overlay,
    ]);
    expect(text(annot!, "Contents")).toBe(comment);
  });

  test("a square or ink without one gets no /Contents", async () => {
    const annots = await exportedAnnotations([
      { type: "rect", id: "r", pageId: "p1", rect: rects[0]!, color: "#b13a2e", strokeWidth: 2, fill: null },
      { type: "ink", id: "i", pageId: "p1", paths: [[{ x: 72, y: 600 }, { x: 90, y: 610 }]], color: "#b13a2e", width: 2 },
    ]);
    for (const annot of annots) expect(annot.get(PDFName.of("Contents"))).toBeUndefined();
  });
});

describe("an imported annotation keeps its flags and note state", () => {
  const note = {
    type: "note",
    pageId: "p1",
    rect: { x: 72, y: 700, w: 24, h: 24 },
    text: "Looks right",
    color: "#f4d674",
  };

  test.each([
    { type: "highlight", rects, color: "#f4d674", opacity: 0.4 },
    { type: "rect", rect: rects[0], color: "#b13a2e", strokeWidth: 2, fill: null },
    { type: "ink", paths: [[{ x: 72, y: 600 }, { x: 140, y: 640 }]], color: "#b13a2e", width: 2 },
    note,
    {
      type: "text", rect: rects[0], text: "box", fontSize: 12, color: "#1a1815",
      bold: false, align: "left", fontFamily: "sans",
    },
  ])("a $type keeps Locked and NoPrint", async (shape) => {
    // Locked (128) without Print (4): a source mark that never printed.
    const [annot] = await exportedAnnotations([
      { ...shape, id: "a", pageId: "p1", sourceFlags: 128 } as unknown as Overlay,
    ]);
    expect(annot!.get(PDFName.of("F"))?.toString()).toBe("128");
  });

  test("a sticky note keeps its icon, open state and review state", async () => {
    const [annot] = await exportedAnnotations([
      {
        ...note,
        id: "n",
        sourceIcon: "Key",
        sourceOpen: true,
        sourceState: "Accepted",
        sourceStateModel: "Review",
      } as unknown as Overlay,
    ]);
    expect(annot!.get(PDFName.of("Name"))?.toString()).toBe("/Key");
    expect(annot!.get(PDFName.of("Open"))?.toString()).toBe("true");
    expect(text(annot!, "State")).toBe("Accepted");
    expect(text(annot!, "StateModel")).toBe("Review");
  });

  test("a note authored in Shiori keeps the defaults", async () => {
    const [annot] = await exportedAnnotations([{ ...note, id: "mine" } as unknown as Overlay]);
    expect(annot!.get(PDFName.of("F"))?.toString()).toBe("4");
    expect(annot!.get(PDFName.of("Name"))?.toString()).toBe("/Note");
    expect(annot!.get(PDFName.of("Open"))?.toString()).toBe("false");
    expect(annot!.get(PDFName.of("State"))).toBeUndefined();
  });
});

describe("a text box keeps its fill, border and opacity", () => {
  const box = {
    type: "text", id: "t", pageId: "p1", rect: { x: 72, y: 600, w: 200, h: 40 }, text: "Note",
    fontSize: 12, color: "#1a1815", bold: false, align: "left", fontFamily: "sans",
  };

  function appearance(annot: PDFDict): string {
    const ap = annot.lookup(PDFName.of("AP"), PDFDict);
    const stream = ap.lookup(PDFName.of("N"), PDFRawStream);
    return new TextDecoder().decode(decodePDFRawStream(stream).decode());
  }

  test("in the dictionary and in the appearance it draws", async () => {
    const [annot] = await exportedAnnotations([
      { ...box, fill: "#ffff99", borderWidth: 2, borderColor: "#ff0000", opacity: 0.6 } as unknown as Overlay,
    ]);
    expect(annot!.get(PDFName.of("C"))?.toString()).toBe("[ 1 1 0.6 ]");
    expect(annot!.lookup(PDFName.of("BS"), PDFDict).get(PDFName.of("W"))?.toString()).toBe("2");
    expect(annot!.get(PDFName.of("CA"))?.toString()).toBe("0.6");
    const ops = appearance(annot!);
    expect(ops).toContain("1 1 0.6 rg");
    expect(ops).toContain("1 0 0 RG");
    expect(ops).toMatch(/\/GS0 gs/);
  });

  test("a text box authored in Shiori stays unfilled and opaque", async () => {
    const [annot] = await exportedAnnotations([box as unknown as Overlay]);
    expect(annot!.get(PDFName.of("C"))).toBeUndefined();
    expect(annot!.get(PDFName.of("BS"))).toBeUndefined();
    expect(annot!.get(PDFName.of("CA"))).toBeUndefined();
  });
});
