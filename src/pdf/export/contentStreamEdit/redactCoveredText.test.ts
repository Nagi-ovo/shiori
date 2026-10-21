import { describe, expect, test } from "bun:test";
import {
  decodePDFRawStream,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFString,
  type PDFPage,
} from "pdf-lib";
import type { PageModel, PdfRect } from "../../model/types";
import { deterministicTextVerticalMetrics } from "../../geometry/textMetrics";
import { expandPdfRectSides } from "../../../editor/components/textHighlightGeometry";
import { redactCoveredTextOnPage } from "./redactCoveredText";
import { tokenizeContentStream } from "./tokenizer";

const enc = new TextEncoder();

async function pageWithContent(
  source: string,
  descriptor = { Ascent: 800, Descent: -200 },
): Promise<PDFPage> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = doc.context.register(
    doc.context.obj({
      Type: "Font",
      Subtype: "Type1",
      FirstChar: 32,
      Widths: Array.from({ length: 64 }, (_, index) =>
        index === 0 ? 250 : 500,
      ),
      FontDescriptor: { ...descriptor, MissingWidth: 500 },
    }),
  );
  page.node.setFontDictionary(PDFName.of("F1"), font);
  page.node.set(
    PDFName.of("Contents"),
    doc.context.register(doc.context.flateStream(enc.encode(source))),
  );
  return page;
}

async function pageWithFormXObject(source: string): Promise<PDFPage> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const form = doc.context.register(
    doc.context.flateStream(enc.encode(""), {
      Type: "XObject",
      Subtype: "Form",
      BBox: [0, 0, 20, 20],
    }),
  );
  page.node.setXObject(PDFName.of("XO"), form);
  page.node.set(
    PDFName.of("Contents"),
    doc.context.register(doc.context.flateStream(enc.encode(source))),
  );
  return page;
}

// The contentText cover the editor builds for a run at baseline 700 from
// x=100: a glyph band (normalized font metrics, or canvas ink bounds) padded
// by the editor's 0.8pt cover pad (TextHighlightLayer).
const PAGE: PageModel = {
  id: "p1",
  sourceIndex: 0,
  rotation: 0,
  widthPt: 612,
  heightPt: 792,
};
const COVER_PAD_PT = 0.8;
function editorCoverRect(width: number, band: { ascent: number; descent: number }): PdfRect {
  return expandPdfRectSides(
    { x: 100, y: 700 - band.descent, w: width, h: band.ascent + band.descent },
    { left: COVER_PAD_PT, right: COVER_PAD_PT, vertical: COVER_PAD_PT },
    PAGE,
  );
}
// Arial's FontDescriptor: an ascent+descent span of 1.117 em.
const ARIAL_DESCRIPTOR = { Ascent: 905, Descent: -212 };

describe("page text redaction with editor-built cover rects", () => {
  test("excises glyphs under a cover built from normalized font metrics", async () => {
    const page = await pageWithContent(
      "BT /F1 12 Tf 100 700 Td (ABC) Tj ET",
      ARIAL_DESCRIPTOR,
    );
    const band = deterministicTextVerticalMetrics(12, {
      ascent: 0.905,
      descent: -0.212,
    });

    const report = redactCoveredTextOnPage(page, [editorCoverRect(18, band)]);

    expect(report.removedCount).toBe(3);
    expect(report.cleanRects).toEqual([true]);
  });

  test("excises digits under a cover built from canvas ink bounds", async () => {
    const page = await pageWithContent(
      "BT /F1 12 Tf 100 700 Td (12345) Tj ET",
      ARIAL_DESCRIPTOR,
    );
    // Digits have no descender; their ink tops out near cap height.
    const band = { ascent: 0.716 * 12, descent: 0 };

    const report = redactCoveredTextOnPage(page, [editorCoverRect(30, band)]);

    expect(report.removedCount).toBe(5);
    expect(report.cleanRects).toEqual([true]);
  });

  test("excises dashes under a cover built from their floating ink bounds", async () => {
    const page = await pageWithContent(
      "BT /F1 24 Tf 100 700 Td (---) Tj ET",
      ARIAL_DESCRIPTOR,
    );
    // Arial hyphen ink at 24pt: 5.155pt to 7.275pt above the baseline.
    const band = { ascent: 7.275, descent: -5.155 };

    const report = redactCoveredTextOnPage(page, [editorCoverRect(36, band)]);

    expect(report.removedCount).toBe(3);
    expect(report.cleanRects).toEqual([true]);
  });

  test("excises underscores under a cover built from their ink below the baseline", async () => {
    const page = await pageWithContent(
      "BT /F1 12 Tf 100 700 Td (___) Tj ET",
      ARIAL_DESCRIPTOR,
    );
    const band = { ascent: -0.9, descent: 1.5 };

    const report = redactCoveredTextOnPage(page, [editorCoverRect(18, band)]);

    expect(report.removedCount).toBe(3);
    expect(report.cleanRects).toEqual([true]);
  });

  test("keeps a large heading glyph whose box holds a body-line cover", async () => {
    // A 60pt "W" (advance 30pt) behind a 12pt body line: the line's cover
    // spans the W's advance and sits inside its box, but most of the W is
    // outside the cover and still visible.
    const page = await pageWithContent(
      "BT /F1 60 Tf 100 690 Td (W) Tj ET BT /F1 12 Tf 100 700 Td (ABCDEF) Tj ET",
      ARIAL_DESCRIPTOR,
    );
    const band = deterministicTextVerticalMetrics(12, {
      ascent: 0.905,
      descent: -0.212,
    });

    const report = redactCoveredTextOnPage(page, [editorCoverRect(36, band)]);

    expect(report.removedCount).toBe(6);
    expect(report.cleanRects).toEqual([false]);
  });

  test("keeps a large glyph behind dashes under their floating ink cover", async () => {
    // A 60pt "W" (advance 30pt) behind eight 24pt hyphens: the hyphens'
    // thin ink cover spans the W's advance and sits inside its box too, but
    // only a sliver of the W is under it.
    const page = await pageWithContent(
      "BT /F1 60 Tf 130 690 Td (W) Tj ET BT /F1 24 Tf 100 700 Td (--------) Tj ET",
      ARIAL_DESCRIPTOR,
    );
    const band = { ascent: 7.275, descent: -5.155 };

    const report = redactCoveredTextOnPage(page, [editorCoverRect(96, band)]);

    expect(report.removedCount).toBe(8);
    expect(report.cleanRects).toEqual([false]);
  });

  test.each([
    ["on another line", 690],
    ["on the same baseline", 700],
  ])("keeps a slightly larger glyph %s behind dashes under their ink cover", async (_, baseline) => {
    // A 29pt "W" (advance 14.5pt) over two of eight 24pt hyphens: its box is
    // only a little taller than theirs, and most of it is outside the cover.
    const page = await pageWithContent(
      `BT /F1 29 Tf 130 ${baseline} Td (W) Tj ET BT /F1 24 Tf 100 700 Td (--------) Tj ET`,
      ARIAL_DESCRIPTOR,
    );
    const band = { ascent: 7.275, descent: -5.155 };

    const report = redactCoveredTextOnPage(page, [editorCoverRect(96, band)]);

    expect(report.removedCount).toBe(8);
    expect(report.cleanRects).toEqual([false]);
  });

  test("keeps dashes on two overlapping lines that each span the cover", async () => {
    // Two rows of hyphens a point apart: either could be the selected run.
    const page = await pageWithContent(
      "BT /F1 24 Tf 100 700 Td (--------) Tj 0 -1 Td (--------) Tj ET",
      ARIAL_DESCRIPTOR,
    );
    const band = { ascent: 7.275, descent: -5.155 };

    const report = redactCoveredTextOnPage(page, [editorCoverRect(96, band)]);

    expect(report.removedCount).toBe(0);
    expect(report.cleanRects).toEqual([false]);
  });

  test("keeps a large heading glyph behind a cover whose own text is unplaced", async () => {
    // The body line is in a font the walk cannot measure, so nothing holds a
    // core band in the cover; the W still only fills a third of its width.
    const page = await pageWithContent(
      "BT /F1 60 Tf 100 690 Td (W) Tj ET BT /F2 12 Tf 100 700 Td (ABCDEFGHI) Tj ET",
      ARIAL_DESCRIPTOR,
    );
    page.node.setFontDictionary(
      PDFName.of("F2"),
      page.doc.context.register(
        page.doc.context.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" }),
      ),
    );
    const band = { ascent: 0.716 * 12, descent: 0 };

    const report = redactCoveredTextOnPage(page, [editorCoverRect(90, band)]);

    expect(report.removedCount).toBe(0);
  });

  test("keeps the line above whose descent box reaches into the cover", async () => {
    // Leading of one em: the upper line's descent box dips below the
    // lower line's cover top, but none of its glyphs was selected.
    const page = await pageWithContent(
      "BT /F1 12 Tf 100 712 Td (ABC) Tj 0 -12 Td (ABC) Tj ET",
      ARIAL_DESCRIPTOR,
    );
    const band = deterministicTextVerticalMetrics(12, {
      ascent: 0.905,
      descent: -0.212,
    });

    const report = redactCoveredTextOnPage(page, [editorCoverRect(18, band)]);

    expect(report.removedCount).toBe(3);
    expect(report.cleanRects).toEqual([false]);
  });
});

describe("page text redaction clean rect report", () => {
  test("reports clean when all intersecting glyphs are fully inside", async () => {
    const page = await pageWithContent("BT /F1 12 Tf 100 700 Td (A) Tj ET");
    const rect: PdfRect = { x: 99, y: 697, w: 8, h: 13 };

    const report = redactCoveredTextOnPage(page, [rect]);

    expect(report.removedCount).toBe(1);
    expect(report.cleanRects).toEqual([true]);
  });

  test("reports dirty when a glyph only partially overlaps the rect", async () => {
    const page = await pageWithContent("BT /F1 12 Tf 100 700 Td (A) Tj ET");
    const rect: PdfRect = { x: 99, y: 697, w: 4, h: 13 };

    const report = redactCoveredTextOnPage(page, [rect]);

    expect(report.removedCount).toBe(0);
    expect(report.cleanRects).toEqual([false]);
  });

  test("reports clean when the walk succeeds with no intersecting glyphs", async () => {
    const page = await pageWithContent("BT /F1 12 Tf 100 700 Td (A) Tj ET");
    const rect: PdfRect = { x: 300, y: 300, w: 20, h: 20 };

    const report = redactCoveredTextOnPage(page, [rect]);

    expect(report.removedCount).toBe(0);
    expect(report.cleanRects).toEqual([true]);
  });

  test("reports dirty when an XObject use overlaps the rect", async () => {
    const page = await pageWithFormXObject("q 1 0 0 1 100 100 cm /XO Do Q");
    const rect: PdfRect = { x: 105, y: 105, w: 5, h: 5 };

    const report = redactCoveredTextOnPage(page, [rect]);

    expect(report.removedCount).toBe(0);
    expect(report.cleanRects).toEqual([false]);
  });

  test("reports dirty when an inline image overlaps the rect", async () => {
    // Invisible (Tr 3) OCR text over inline scan pixels: removing the glyphs
    // does not remove the visible word, so the rect still needs its cover.
    const page = await pageWithContent(
      "q 66 0 0 10 100 698 cm BI /W 1 /H 1 /BPC 8 /CS /G ID \u0000 EI Q " +
        "BT 3 Tr /F1 12 Tf 100 700 Td (A) Tj ET",
    );
    const rects: PdfRect[] = [
      { x: 99, y: 697, w: 8, h: 13 },
      { x: 300, y: 300, w: 20, h: 20 },
    ];

    const report = redactCoveredTextOnPage(page, rects);

    expect(report.removedCount).toBe(1);
    expect(report.cleanRects).toEqual([false, true]);
  });

  test("excises body text on a page whose footer font has no /Widths", async () => {
    const page = await pageWithContent(
      "BT /F1 12 Tf 100 700 Td (ABC) Tj ET BT /F2 9 Tf 280 40 Td (Page 1) Tj ET",
    );
    // A Standard-14 font as pdf-lib writes it: no /FirstChar or /Widths.
    page.node.setFontDictionary(
      PDFName.of("F2"),
      page.doc.context.register(
        page.doc.context.obj({
          Type: "Font",
          Subtype: "Type1",
          BaseFont: "Helvetica",
        }),
      ),
    );
    const rect: PdfRect = { x: 99, y: 697, w: 20, h: 13 };

    const report = redactCoveredTextOnPage(page, [rect]);

    expect(report.removedCount).toBe(3);
    // The footer's extent is unknown, so no rect can be proven clean.
    expect(report.cleanRects).toEqual([false]);
  });

  test("fails closed to dirty rects on walk failure", async () => {
    const page = await pageWithContent("BT BT");
    const rects: PdfRect[] = [
      { x: 99, y: 697, w: 8, h: 13 },
      { x: 300, y: 300, w: 20, h: 20 },
    ];

    const report = redactCoveredTextOnPage(page, rects);

    expect(report).toEqual({
      removedCount: 0,
      cleanRects: [false, false],
      rectFonts: [{ kind: "none" }, { kind: "none" }],
    });
  });
});

// The property list each BDC of the page's current /Contents points at,
// resolved through the page's /Properties when it is named.
function bdcPropertyLists(page: PDFPage): Array<PDFDict | undefined> {
  const contents = page.node.lookup(PDFName.of("Contents"), PDFRawStream);
  const ops = tokenizeContentStream(decodePDFRawStream(contents).decode());
  const properties = page.node
    .Resources()
    ?.lookupMaybe(PDFName.of("Properties"), PDFDict);
  return ops
    .filter((op) => op.operator === "BDC")
    .map((op) => {
      const operand = op.operands[1];
      return operand?.kind === "name"
        ? properties?.lookupMaybe(PDFName.of(operand.value), PDFDict)
        : undefined;
    });
}

describe("page text redaction of marked-content alternate text", () => {
  test("drops /ActualText from a named property list around removed glyphs", async () => {
    const page = await pageWithContent(
      "/Span /P1 BDC BT /F1 12 Tf 100 700 Td (A) Tj ET EMC " +
        "/Span /P1 BDC BT /F1 12 Tf 300 700 Td (B) Tj ET EMC",
    );
    const context = page.doc.context;
    const layer = context.register(context.obj({ Type: "OCG" }));
    const p1 = context.obj({ ActualText: PDFString.of("Alice"), OC: layer });
    const shared = context.obj({ P1: context.register(p1) });
    page.node.Resources()!.set(PDFName.of("Properties"), shared);

    const report = redactCoveredTextOnPage(page, [{ x: 99, y: 697, w: 8, h: 13 }]);

    expect(report.removedCount).toBe(1);
    const [edited, untouched] = bdcPropertyLists(page);
    expect(edited?.has(PDFName.of("ActualText"))).toBe(false);
    expect(edited?.get(PDFName.of("OC"))).toBe(layer);
    // The span whose glyph stayed, and the shared resources, keep the text.
    expect(untouched).toBe(p1);
    expect(p1.has(PDFName.of("ActualText"))).toBe(true);
    expect(shared.keys().map(String)).toEqual(["/P1"]);
  });
});
