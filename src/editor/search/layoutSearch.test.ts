import { describe, expect, test } from "bun:test";
import { findLayoutSearchMatches, indexLayoutSearchPages } from "./layoutSearch";

describe("layout-aware search pages", () => {
  test("a long document past the wrap budget still indexes, without joins on later pages", () => {
    // Every space is a soft wrap, so each page's joined projection needs one
    // mapping per wrap: two pages fit the document budget, the third does not.
    const wraps = 40_000;
    const text = "ab ".repeat(wraps) + "end";
    const layoutBreaks = Array.from({ length: wraps }, (_, i) => ({ start: i * 3 + 2, end: i * 3 + 3 }));
    const pages = indexLayoutSearchPages(
      [1, 2, 3].map((pageNumber) => ({ pageId: `p${pageNumber}`, pageNumber, text, layoutBreaks })),
    );
    expect(pages.map((page) => page.alternateIndexes.length)).toEqual([1, 1, 0]);
    const pagesWith = (query: string) => [
      ...new Set(findLayoutSearchMatches(pages, query).matches.map((match) => match.pageNumber)),
    ];
    expect(pagesWith("abend")).toEqual([1, 2]);
    expect(pagesWith("ab end")).toEqual([1, 2, 3]);
  });
});
