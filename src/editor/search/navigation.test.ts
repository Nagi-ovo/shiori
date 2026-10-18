import "../../test/setupDom";
import { describe, expect, test } from "bun:test";
import type { PageModel } from "../../pdf/model/types";
import type { SearchMatch } from "./findMatches";
import {
  pageJumpForSearchMatch,
  pageJumpForOffscreenSearchMatch,
  searchOffsetFromDisplayRects,
  shouldScrollToSearchRects,
} from "./navigation";

const pages: PageModel[] = [
  { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 100, heightPt: 200 },
  { id: "p2", sourceIndex: 1, rotation: 0, widthPt: 100, heightPt: 200 },
  { id: "p3", sourceIndex: 2, rotation: 0, widthPt: 100, heightPt: 200 },
];

function match(pageId: string): SearchMatch {
  return {
    pageId,
    pageNumber: 1,
    index: 0,
    end: 6,
    snippet: { before: "", match: "needle", after: "" },
  };
}

describe("search navigation", () => {
  test("does not request a page jump when the matched page is already visible", () => {
    const root = document.createElement("div");
    root.append(visiblePageNode("p3", rect({ top: 120, bottom: 320 })));

    expect(pageJumpForOffscreenSearchMatch(match("p3"), pages, root)).toBeNull();
  });

  test("requests a page jump when the matched page is not visible", () => {
    const root = document.createElement("div");
    root.append(visiblePageNode("p3", rect({ top: 620, bottom: 820 })));

    expect(pageJumpForOffscreenSearchMatch(match("p3"), pages, root)).toEqual({
      pageId: "p3",
      index: 2,
    });
  });

  test("builds a page jump for the matched page", () => {
    expect(pageJumpForSearchMatch(match("p3"), pages)).toEqual({
      pageId: "p3",
      index: 2,
    });
  });

  test("returns null when a match points at a stale page id", () => {
    expect(pageJumpForSearchMatch(match("missing"), pages)).toBeNull();
  });

  test("uses the top-most highlight rect as the precise scroll offset", () => {
    expect(
      searchOffsetFromDisplayRects([
        { x: 20, y: 180, w: 30, h: 10 },
        { x: 10, y: 120, w: 40, h: 10 },
      ]),
    ).toBe(120);
  });

  test("does not request a precise offset when no highlight rect exists", () => {
    expect(searchOffsetFromDisplayRects([])).toBeNull();
  });

  test("keeps the viewport still when a search rect is already visible", () => {
    expect(
      shouldScrollToSearchRects({
        displayRects: [{ x: 10, y: 120, w: 40, h: 12 }],
        pageRect: rect({ top: 0, bottom: 800, left: 0, right: 600 }),
        viewportRect: rect({ top: 0, bottom: 500, left: 0, right: 600 }),
      }),
    ).toBe(false);
  });

  test("requests precise scroll when all search rects are outside the viewport", () => {
    expect(
      shouldScrollToSearchRects({
        displayRects: [{ x: 10, y: 720, w: 40, h: 12 }],
        pageRect: rect({ top: 0, bottom: 800, left: 0, right: 600 }),
        viewportRect: rect({ top: 0, bottom: 500, left: 0, right: 600 }),
      }),
    ).toBe(true);
  });
});

function visiblePageNode(pageId: string, pageRect: DOMRect): HTMLElement {
  const scroller = document.createElement("div");
  scroller.style.overflowY = "auto";
  Object.defineProperty(scroller, "clientHeight", {
    configurable: true,
    value: 500,
  });
  Object.defineProperty(scroller, "scrollHeight", {
    configurable: true,
    value: 1000,
  });
  scroller.getBoundingClientRect = () =>
    rect({ top: 0, bottom: 500, left: 0, right: 600 });

  const page = document.createElement("div");
  page.dataset.shioriPageId = pageId;
  page.getBoundingClientRect = () => pageRect;
  scroller.append(page);
  return scroller;
}

function rect({
  top,
  bottom,
  left = 0,
  right = 600,
}: {
  top: number;
  bottom: number;
  left?: number;
  right?: number;
}): DOMRect {
  return {
    top,
    bottom,
    left,
    right,
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    toJSON: () => ({}),
  } as DOMRect;
}
