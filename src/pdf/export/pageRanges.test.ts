import { describe, expect, test } from "bun:test";
import { parsePageRange, selectPagesForExport } from "./pageRanges";

describe("export page range parsing", () => {
  test("parses mixed ranges, unicode dashes, duplicates, and Chinese commas", () => {
    expect(parsePageRange("3, 1–2, 2, 8—7，99", 10)).toEqual([
      1, 2, 3, 7, 8, 10,
    ]);
  });

  test("ignores non-page tokens without rejecting valid chunks", () => {
    expect(parsePageRange("cover, 2, x-4, 5-4", 6)).toEqual([2, 4, 5]);
  });

  test("selects pages from the reordered model order", () => {
    const pages = [
      { id: "page-c", sourceIndex: 2 },
      { id: "page-a", sourceIndex: 0 },
      { id: "page-b", sourceIndex: 1 },
    ];
    expect(selectPagesForExport("all", pages, 2, "")).toEqual(pages);
    expect(selectPagesForExport("current", pages, 2, "")).toEqual([pages[1]]);
    expect(selectPagesForExport("range", pages, 1, "1,3")).toEqual([
      pages[0],
      pages[2],
    ]);
  });
});
