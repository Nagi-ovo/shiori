import type { PageModel } from "../../pdf/model/types";
import type { DisplayRect } from "../textSelection/highlightRects";
import type { SearchMatch } from "./findMatches";

export type SearchPageJump = {
  pageId: string;
  index: number;
};

type RectLike = Pick<DOMRect, "bottom" | "left" | "right" | "top">;

const VISIBLE_EDGE_TOLERANCE_PX = 2;
const SCROLLABLE_OVERFLOW = /auto|scroll|overlay/i;

export function pageJumpForSearchMatch(
  match: SearchMatch,
  pages: PageModel[],
): SearchPageJump | null {
  const index = pages.findIndex((page) => page.id === match.pageId);
  if (index < 0) return null;
  return { pageId: match.pageId, index };
}

export function pageJumpForOffscreenSearchMatch(
  match: SearchMatch,
  pages: PageModel[],
  root: ParentNode = document,
): SearchPageJump | null {
  const jump = pageJumpForSearchMatch(match, pages);
  if (!jump) return null;
  const pageNode = searchPageElement(match.pageId, root);
  if (!pageNode) return jump;
  return isElementVisibleInScrollport(pageNode) ? null : jump;
}

export function searchOffsetFromDisplayRects(
  rects: DisplayRect[],
): number | null {
  if (rects.length === 0) return null;
  return Math.max(0, Math.min(...rects.map((rect) => rect.y)));
}

export function shouldScrollToSearchRects({
  displayRects,
  pageRect,
  viewportRect,
}: {
  displayRects: DisplayRect[];
  pageRect: RectLike;
  viewportRect: RectLike;
}): boolean {
  if (displayRects.length === 0) return false;
  return !displayRects.some((rect) =>
    rectIntersects(
      {
        top: pageRect.top + rect.y,
        bottom: pageRect.top + rect.y + rect.h,
        left: pageRect.left + rect.x,
        right: pageRect.left + rect.x + rect.w,
      },
      viewportRect,
    ),
  );
}

export function searchViewportForElement(element: HTMLElement): RectLike {
  return nearestScrollContainer(element)?.getBoundingClientRect() ?? {
    top: 0,
    left: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
  };
}

function searchPageElement(
  pageId: string,
  root: ParentNode,
): HTMLElement | null {
  const candidates = root.querySelectorAll<HTMLElement>("[data-shiori-page-id]");
  for (const node of candidates) {
    if (node.dataset.shioriPageId === pageId) return node;
  }
  return null;
}

function isElementVisibleInScrollport(element: HTMLElement): boolean {
  return rectIntersects(
    element.getBoundingClientRect(),
    searchViewportForElement(element),
  );
}

function nearestScrollContainer(element: HTMLElement): HTMLElement | null {
  let current = element.parentElement;
  while (current) {
    const style = window.getComputedStyle(current);
    if (
      SCROLLABLE_OVERFLOW.test(style.overflowY) ||
      current.scrollHeight > current.clientHeight
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function rectIntersects(rect: RectLike, viewport: RectLike): boolean {
  return (
    rect.bottom > viewport.top + VISIBLE_EDGE_TOLERANCE_PX &&
    rect.top < viewport.bottom - VISIBLE_EDGE_TOLERANCE_PX &&
    rect.right > viewport.left + VISIBLE_EDGE_TOLERANCE_PX &&
    rect.left < viewport.right - VISIBLE_EDGE_TOLERANCE_PX
  );
}
