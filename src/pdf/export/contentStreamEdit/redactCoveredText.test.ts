import { describe, expect, test } from "bun:test";
import { PDFDocument, PDFName, type PDFPage } from "pdf-lib";
import type { PageModel, PdfRect } from "../../model/types";
import { deterministicTextVerticalMetrics } from "../../geometry/textMetrics";
import { expandPdfRectSides } from "../../../editor/components/textHighlightGeometry";
import { redactCoveredTextOnPage } from "./redactCoveredText";

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
