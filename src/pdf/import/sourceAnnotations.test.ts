import { describe, expect, test } from "bun:test";
import {
  PDFArray,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFString,
  type PDFObject,
  type PDFRef,
} from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PageModel } from "../model/types";
import type { PdfDocument } from "../engine/types";
import { importPdfAnnotations } from "./annotations";

// The file reader is right when an import through it matches an import
// through pdf.js, which the importer was written against: same overlays,
// same ids, same annotations claimed from the canvas. pdf.js is the oracle.

const page: PageModel = { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 300, heightPt: 400 };
const NOW = 1_700_000_000_000;

async function importBoth(bytes: Uint8Array) {
  const doc = await pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  const run = async (annotationReader: "file" | "pdfjs") => {
    const claimed: string[] = [];
    const reported: unknown[] = [];
    const proxy = new Proxy(doc, {
      get(target, key) {
        if (key === "annotationStorage") {
          return { setValue: (id: string, value: { noView?: boolean }) => value.noView && claimed.push(id) };
        }
        const value = Reflect.get(target, key) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as unknown as PdfDocument;
    const overlays = await importPdfAnnotations(proxy, [page], bytes, NOW, {
      annotationReader,
      onSuppress: (_index, annotation) => reported.push(annotation),
    });
    return { overlays, claimed, reported };
  };
  try {
    return { file: await run("file"), pdfjs: await run("pdfjs") };
  } finally {
    await doc.destroy();
  }
}

async function onePage(build: (pdf: PDFDocument, add: (dict: Record<string, unknown>, direct?: boolean) => PDFRef | null) => void) {
  const pdf = await PDFDocument.create();
  const pdfPage = pdf.addPage([300, 400]);
  const annots: PDFObject[] = [];
  const add = (entries: Record<string, unknown>, direct = false) => {
    const dict = pdf.context.obj({ Type: "Annot", ...entries } as never);
    if (direct) {
      annots.push(dict);
      return null;
    }
    const ref = pdf.context.register(dict);
    annots.push(ref);
    return ref;
  };
  build(pdf, add);
  pdfPage.node.set(PDFName.of("Annots"), pdf.context.obj(annots as never) as PDFArray);
  return pdf.save({ useObjectStreams: false });
}

const utf16 = (text: string) => PDFHexString.fromText(text);

describe("the file annotation reader", () => {
  test("reads text markup as pdf.js does: colours, quads, opacity, flags", async () => {
    const bytes = await onePage((_pdf, add) => {
      // A skewed quad, an RGB colour, an opacity and PDFDocEncoding text.
      add({
        Subtype: "Highlight", Rect: [18, 18, 122, 42], C: [0.2, 0.6, 1], CA: 0.3,
        QuadPoints: [20, 40, 120, 41, 21, 20, 119, 19], T: utf16("Réviseur 审阅"),
        Contents: PDFString.of("bullet \x80 dash \x85"), M: PDFString.of("D:20260925101500+08'00'"),
        CreationDate: PDFString.of("D:20260924"),
      });
      // CMYK, then gray, and a quad count pdf.js rejects (not shown).
      add({ Subtype: "Underline", Rect: [18, 58, 122, 82], C: [0.1, 0.7, 0.2, 0.05], QuadPoints: [20, 80, 120, 80, 20, 60, 120, 60] });
      add({ Subtype: "StrikeOut", Rect: [18, 98, 122, 122], C: [0.5], QuadPoints: [20, 120, 120, 120, 20, 100, 120, 100] });
      add({ Subtype: "Highlight", Rect: [18, 138, 122, 162], QuadPoints: [20, 160, 120, 160, 20, 140] });
      // Invisible is ignored for a known subtype; NoView hides.
      add({ Subtype: "Highlight", F: 1, Rect: [18, 178, 122, 202], QuadPoints: [20, 200, 120, 200, 20, 180, 120, 180] });
      add({ Subtype: "Highlight", F: 32, Rect: [18, 218, 122, 242], QuadPoints: [20, 240, 120, 240, 20, 220, 120, 220] });
      // A direct dictionary, which pdf.js names by its place on the page.
      add({ Subtype: "StrikeOut", Rect: [18, 258, 122, 282], QuadPoints: [20, 280, 120, 280, 20, 260, 120, 260] }, true);
    });
    const { file, pdfjs } = await importBoth(bytes);
    expect(file.overlays).toHaveLength(5);
    expect(file).toEqual(pdfjs);
    // PDFium hides what Shiori claims by /Rect. pdf.js moves a markup's rect
    // to the bounds of the appearance it draws when there is none; the
    // claim still names the file's.
    expect(pdfjs.reported[0]).toEqual({ subtype: "Highlight", rect: [18, 18, 122, 42] });
  });

  test("reads notes, replies, shapes and ink as pdf.js does", async () => {
    const bytes = await onePage((_pdf, add) => {
      const parent = add({
        Subtype: "Text", Rect: [40, 300, 60, 320], C: [1, 0.8, 0], T: PDFString.of("Ann"),
        Contents: utf16("Parent note"), M: PDFString.of("D:20260101"),
      });
      // A group reply takes its parent's author, text, dates and colour.
      add({ Subtype: "Text", Rect: [70, 300, 90, 320], IRT: parent, RT: "Group", Contents: PDFString.of("ignored") });
      add({ Subtype: "Text", Rect: [100, 300, 120, 320], IRT: parent, Contents: PDFString.of("A reply") });
      // No appearance: pdf.js draws the square and rounds its rect to float32.
      add({ Subtype: "Square", Rect: [10.1, 20.3, 90.7, 80.9], C: [0, 0, 1], BS: { W: 3 }, IC: [1, 0, 0] });
      add({ Subtype: "Square", Rect: [110, 20, 190, 80], C: [0, 0, 1], Border: [0, 0, 2, [3, 0]] });
      add({ Subtype: "Square", Rect: [210, 20, 290, 80], Border: [0, 0, 5, [0, 0]] });
      // A border wider than half the rect falls back to 1; CA 0 reads as 1.
      add({ Subtype: "Ink", Rect: [10, 100, 60, 150], CA: 0, BS: { W: 50 }, InkList: [[12, 102, 30, 140, 58, 120], [15, 110, 16, 111]] });
      add({ Subtype: "Link", Rect: [200, 300, 250, 320], A: { S: "URI", URI: PDFString.of("https://example.com") } });
      const note = add({ Subtype: "Text", Rect: [150, 300, 170, 320], Contents: PDFString.of("with popup") });
      add({ Subtype: "Popup", Rect: [150, 200, 250, 280], Parent: note });
      add({ Subtype: "Widget", FT: "Tx", Rect: [10, 350, 100, 370] });
    });
    const { file, pdfjs } = await importBoth(bytes);
    expect(file.overlays.map((overlay) => overlay.type)).toEqual(["note", "note", "note", "rect", "rect", "rect", "ink", "note"]);
    expect(file).toEqual(pdfjs);
  });

  test("reads free text size and colour from its appearance, as pdf.js does", async () => {
    const bytes = await onePage((pdf, add) => {
      const appearance = pdf.context.flateStream("q 0 0 1 rg BT 2 0 0 2 0 0 Tm /F1 9 Tf 5 5 Td (Big) Tj ET Q", {
        Type: "XObject", Subtype: "Form", BBox: [0, 0, 100, 40],
      });
      add({ Subtype: "FreeText", Rect: [20, 20, 120, 60], DA: PDFString.of("/Helv 11 Tf 1 0 0 rg"), Contents: PDFString.of("From AP"), AP: { N: pdf.context.register(appearance) } });
      add({ Subtype: "FreeText", Rect: [20, 80, 120, 120], DA: PDFString.of("/Helv 11 Tf 0 0.5 0 rg"), Contents: PDFString.of("From DA") });
      add({ Subtype: "FreeText", Rect: [20, 140, 60, 180], DA: PDFString.of("/ZapfDingbats 14 Tf 0 g"), Contents: utf16("✓") }, true);
      add({
        Subtype: "FreeText", Rect: [20, 200, 200, 240], DA: PDFString.of("/Helv 12 Tf 0 g"), Contents: PDFString.of("Styled"),
        RC: PDFString.of(
          '<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml" style="font:italic bold 12pt serif;font-family:serif;font-size:12pt;font-weight:bold;font-style:italic;text-align:center;direction:ltr;color:rgb(0,0,0)"><p dir="ltr">Styled</p></body>',
        ),
      });
    });
    const { file, pdfjs } = await importBoth(bytes);
    expect(file.overlays.map((overlay) => overlay.type)).toEqual(["text", "text", "stamp", "text"]);
    expect(file).toEqual(pdfjs);
  });

  test("an encrypted file is read by pdf.js, whose strings pdf-lib cannot decrypt", async () => {
    const source = await PDFDocument.create();
    source.addPage([300, 400]);
    source.context.trailerInfo.Encrypt = source.context.register(
      source.context.obj({ Filter: "Standard", V: 2 }),
    );
    const bytes = await source.save();
    const highlight = {
      id: "7R", subtype: "Highlight", rect: [20, 20, 120, 40],
      quadPoints: [20, 40, 120, 40, 20, 20, 120, 20], color: [244, 214, 116],
    };
    const proxy = {
      annotationStorage: { setValue: () => undefined },
      getPage: async () => ({ getAnnotations: async () => [highlight] }),
    } as unknown as PdfDocument;
    const overlays = await importPdfAnnotations(proxy, [page], bytes, NOW);
    expect(overlays.map((overlay) => overlay.id)).toEqual(["pdf-annotation-0-7R"]);
  });
});
