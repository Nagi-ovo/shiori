import { describe, expect, test } from "bun:test";
import { MAX_PDF_BYTES, PdfOpenError } from "../pdf/openPolicy";
import type { PageModel } from "../pdf/model/types";
import { insertPdfPages } from "../pdf/merge/insertPdf";
import { PDFDocument } from "pdf-lib";
import {
  assertPdfMergeInputWithinFileLimit,
  planPhysicalAppendInsertion,
} from "./pdfMergeState";

describe("PDF merge input budget", () => {
  test("fails before allocating when the two individually-valid PDFs exceed the cap", () => {
    const oneHundredTwentyMiB = 120 * 1024 * 1024;
    const eightyMiB = 80 * 1024 * 1024;

    expect(() =>
      assertPdfMergeInputWithinFileLimit(oneHundredTwentyMiB, eightyMiB),
    ).not.toThrow();
    expect(() =>
      assertPdfMergeInputWithinFileLimit(oneHundredTwentyMiB, eightyMiB + 1),
    ).toThrow(PdfOpenError);
    expect(() =>
      assertPdfMergeInputWithinFileLimit(MAX_PDF_BYTES, MAX_PDF_BYTES),
    ).toThrow("Combined PDF inputs");
  });
});

describe("physical PDF append with logical insertion", () => {
  test("the real merge appends bytes while the model inserts in the middle", async () => {
    const base = await PDFDocument.create();
    base.addPage([100, 700]);
    base.addPage([200, 700]);
    const incoming = await PDFDocument.create();
    incoming.addPage([300, 700]);

    const result = await insertPdfPages(
      await base.save(),
      await incoming.save(),
      2,
      "incoming.pdf",
    );
    const output = await PDFDocument.load(result.bytes);
    const outputGeometry = output.getPages().map((pdfPage) => ({
      rotation: 0 as const,
      originXPt: 0,
      originYPt: 0,
      widthPt: pdfPage.getWidth(),
      heightPt: pdfPage.getHeight(),
    }));
    const plan = planPhysicalAppendInsertion({
      previousPages: [page("first", 0), page("second", 1)],
      outputGeometry,
      basePhysicalPageCount: 2,
      insertionIndex: 1,
      insertedPageCount: result.insertedPageCount,
      createId: () => "inserted",
    });

    expect(output.getPages().map((pdfPage) => pdfPage.getWidth())).toEqual([
      100, 200, 300,
    ]);
    expect(plan.pages.map((item) => item.id)).toEqual([
      "first",
      "inserted",
      "second",
    ]);
    expect(plan.pages.map((item) => item.sourceIndex)).toEqual([0, 2, 1]);
  });

  test("keeps every existing source index and splices appended pages into UI order", () => {
    const second = page("second", 1, 90);
    const blank = { ...page("blank", -1), blank: true as const };
    const first = page("first", 0);
    const previousPages = [second, blank, first];
    let nextId = 0;

    const result = planPhysicalAppendInsertion({
      previousPages,
      outputGeometry: [612, 500, 300, 320].map((widthPt) => ({
        rotation: 0 as const,
        originXPt: 0,
        originYPt: 0,
        widthPt,
        heightPt: 700,
      })),
      basePhysicalPageCount: 2,
      insertionIndex: 1,
      insertedPageCount: 2,
      createId: () => `new-${++nextId}`,
    });

    expect(result.pages.map((item) => item.id)).toEqual([
      "second",
      "new-1",
      "new-2",
      "blank",
      "first",
    ]);
    expect(result.pages.map((item) => item.sourceIndex)).toEqual([1, 2, 3, -1, 0]);
    expect(result.pages[0]).toBe(second);
    expect(result.pages[3]).toBe(blank);
    expect(result.pages[4]).toBe(first);
    expect(result.pages[0]?.rotation).toBe(90);
    expect(result.sourcePages.map((item) => item.sourceIndex)).toEqual([0, 1, 2, 3]);
    expect(result.sourcePages.map((item) => item.id)).toEqual([
      "first",
      "second",
      "new-1",
      "new-2",
    ]);
    expect(result.insertedPages.map((item) => item.id)).toEqual(["new-1", "new-2"]);
    expect(result.baseSourceIndices).toEqual([0, 1]);
  });

  test("fails closed if old history names a page absent from the physical base", () => {
    expect(() =>
      planPhysicalAppendInsertion({
        previousPages: [page("stale", 2)],
        outputGeometry: [612, 300].map((widthPt) => ({
          rotation: 0 as const,
          originXPt: 0,
          originYPt: 0,
          widthPt,
          heightPt: 700,
        })),
        basePhysicalPageCount: 1,
        insertionIndex: 1,
        insertedPageCount: 1,
        createId: () => "new",
      }),
    ).toThrow("existing-source-index-out-of-range");
  });
});

function page(id: string, sourceIndex: number, rotation: 0 | 90 = 0): PageModel {
  return {
    id,
    sourceIndex,
    rotation,
    widthPt: 612,
    heightPt: 792,
  };
}
