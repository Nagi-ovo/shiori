import { describe, expect, test } from "bun:test";
import {
  canvasCommitScrollTop,
  canvasPageItemHeight,
  canvasSizingLayout,
  pdfPageIndexAt,
  pdfPageScrollTop,
  pdfVisiblePageRange,
  remapScrollTop,
} from "./pdfPageLayout";

const letterPage = {
  id: "letter",
  widthPt: 612,
  heightPt: 792,
  rotation: 0 as const,
};

function uniform(count: number, height: number, docKey = "doc") {
  return {
    docKey,
    totalHeight: count * height,
    contentWidth: 600,
    pages: Array.from({ length: count }, (_, index) => ({
      id: `page-${index}`,
      offset: index * height,
      itemHeight: height,
      pageTop: 30,
      contentHeight: height - 60,
      contentWidth: 600,
    })),
  };
}

describe("page item height", () => {
  test("adds the exact chrome for every page margin", () => {
    expect(canvasPageItemHeight(letterPage, 1, "Tight")).toBe(823);
    expect(canvasPageItemHeight(letterPage, 1, "Comfortable")).toBe(847);
    expect(canvasPageItemHeight(letterPage, 1, "Roomy")).toBe(883);
  });

  test("uses the live scale and rounds to whole pixels", () => {
    expect(canvasPageItemHeight(letterPage, 1.327, "Comfortable")).toBe(1_106);
  });

  test("uses the rotated display height", () => {
    expect(
      canvasPageItemHeight({ ...letterPage, rotation: 90 }, 1.5, "Comfortable"),
    ).toBe(973);
  });

  test("keeps mixed page sizes independent by index", () => {
    const pages = [
      letterPage,
      { id: "landscape-rotated", widthPt: 1_000, heightPt: 500, rotation: 90 as const },
      { id: "square", widthPt: 400, heightPt: 400, rotation: 270 as const },
    ];
    expect(
      pages.map((page) => canvasPageItemHeight(page, 1.25, "Comfortable")),
    ).toEqual([1_045, 1_305, 555]);
  });
});

describe("sizing layout", () => {
  test("stacks pages at summed offsets and keeps the widest page", () => {
    const layout = canvasSizingLayout(
      "doc",
      [letterPage, { id: "wide", widthPt: 1_000, heightPt: 500, rotation: 0 as const }],
      2,
      "Comfortable",
    );
    expect(layout.pages.map((page) => page.offset)).toEqual([0, 1_639]);
    expect(layout.totalHeight).toBe(1_639 + 1_055);
    expect(layout.contentWidth).toBe(2_000);
    expect(layout.pages[0]?.pageTop).toBe(41);
  });
});

describe("page lookup", () => {
  test("finds the page whose slot contains an offset", () => {
    const layout = uniform(24, 1_000);
    expect(pdfPageIndexAt(layout, -5)).toBe(0);
    expect(pdfPageIndexAt(layout, 0)).toBe(0);
    expect(pdfPageIndexAt(layout, 999)).toBe(0);
    expect(pdfPageIndexAt(layout, 1_000)).toBe(1);
    expect(pdfPageIndexAt(layout, 12_345)).toBe(12);
    expect(pdfPageIndexAt(layout, 99_999)).toBe(23);
  });

  test("mounts the viewport, the overscan band and the minimum extra pages", () => {
    const layout = uniform(24, 1_000);
    // Viewport 800px at 12_100: pages 12-12 plus 600px overscan each way.
    expect(pdfVisiblePageRange(layout, 12_100, 800, 600)).toEqual({ start: 11, end: 14 });
    expect(pdfVisiblePageRange(layout, 12_100, 800, 600, 1)).toEqual({ start: 10, end: 15 });
    expect(pdfVisiblePageRange(layout, 0, 800, 200)).toEqual({ start: 0, end: 2 });
    expect(pdfVisiblePageRange(layout, 23_500, 800, 600, 1)).toEqual({ start: 21, end: 24 });
    expect(pdfVisiblePageRange({ ...layout, pages: [], totalHeight: 0 }, 0, 800, 600)).toEqual({ start: 0, end: 0 });
  });

  test("resolves a page top and an offset inside the page", () => {
    const layout = uniform(3, 1_000);
    expect(pdfPageScrollTop(layout, 1)).toBe(1_000);
    expect(pdfPageScrollTop(layout, 1, 200)).toBe(1_230);
    expect(pdfPageScrollTop(layout, 99)).toBe(2_000);
  });
});

describe("scroll anchoring", () => {
  test("pins the pinch anchor under the fingers after a commit", () => {
    const layout = uniform(3, 1_000);
    // Anchor content 400px into page b, fingers 300px below the viewport top.
    expect(canvasCommitScrollTop(layout, "page-1", 400, 300, 800)).toBe(1_130);
    // Clamped to the scrollable range near the end of the document.
    expect(canvasCommitScrollTop(layout, "page-2", 900, 100, 800)).toBe(2_200);
    expect(canvasCommitScrollTop(layout, "missing", 0, 0, 800)).toBe(null);
  });

  test("keeps the viewport centre on the same content across a relayout", () => {
    // Doubling every page: the centre (12_500) is 500px into page 12's
    // 1_000px slot — inside the body — so it maps to the same fraction.
    expect(remapScrollTop(uniform(24, 1_000), uniform(24, 2_000), 12_100, 800)).toBe(24_600);
    // A cover-page reader stays on the cover.
    expect(remapScrollTop(uniform(24, 1_000), uniform(24, 1_000), 0, 800)).toBe(0);
    // Page 12 gone: fall back to the last index; its body point 500px in,
    // recentred, is 2_100 — inside the 2_200 scroll range.
    expect(remapScrollTop(uniform(24, 1_000), uniform(3, 1_000), 12_100, 800)).toBe(2_100);
  });
});
