import { describe, expect, test } from "bun:test";
import { PDFDocument, PDFName, type PDFPage } from "pdf-lib";
import type { PdfRect } from "../../model/types";
import { redactCoveredTextOnPage } from "./redactCoveredText";

const enc = new TextEncoder();

async function pageWithContent(source: string): Promise<PDFPage> {
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
      FontDescriptor: { Ascent: 800, Descent: -200, MissingWidth: 500 },
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
