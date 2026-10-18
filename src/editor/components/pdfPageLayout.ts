import type { PageModel } from "../../pdf/model/types";
import { rotatedSize } from "../../pdf/geometry/coords";
import type { PrefsMargin } from "../store/store";

/**
 * Geometry of the PDF page column. Every page's display size is known from
 * its PDF box and the scale, so the column needs no measurement: each page
 * sits at a computed offset, the total height is a sum, and the pages that
 * intersect the viewport are a search. A zoom commit is then a new layout
 * for the same mounted pages — nothing is remounted, nothing is measured,
 * and the scroll offset that keeps the pinch anchor under the fingers is
 * arithmetic on the layout, applied before paint.
 */

export const PAGE_LABEL_AND_GAP_PX = 19;

export type CanvasPageSize = Pick<
  PageModel,
  "heightPt" | "id" | "rotation" | "widthPt"
>;

export type PageMarginMetrics = {
  bottom: number;
  top: number;
};

export type CanvasPageLayout = {
  contentHeight: number;
  contentWidth: number;
  id: string;
  itemHeight: number;
  offset: number;
  pageTop: number;
};

export type CanvasSizingLayout = {
  docKey: string;
  pages: CanvasPageLayout[];
  totalHeight: number;
  /** Widest page at this scale; the column never narrows below it. */
  contentWidth: number;
};

export type PageRange = { start: number; end: number };

export function pageMarginMetrics(pageMargin: PrefsMargin): PageMarginMetrics {
  return pageMargin === "Tight"
    ? { top: 8, bottom: 4 }
    : pageMargin === "Roomy"
      ? { top: 44, bottom: 28 }
      : { top: 22, bottom: 14 };
}

/**
 * Height of one page's slot: the page, its vertical margins and the label
 * gap above it. Rounded to whole CSS pixels so offsets do not accumulate
 * fractional drift down a long document.
 */
export function canvasPageItemHeight(
  page: CanvasPageSize,
  scale: number,
  pageMargin: PrefsMargin,
): number {
  const size = rotatedSize(page.widthPt, page.heightPt, page.rotation);
  const margin = pageMarginMetrics(pageMargin);
  return Math.round(
    size.height * scale + margin.top + margin.bottom + PAGE_LABEL_AND_GAP_PX,
  );
}

export function canvasSizingLayout(
  docKey: string,
  pages: readonly CanvasPageSize[],
  scale: number,
  pageMargin: PrefsMargin,
): CanvasSizingLayout {
  const margin = pageMarginMetrics(pageMargin);
  const pageTop = margin.top + PAGE_LABEL_AND_GAP_PX;
  let offset = 0;
  let contentWidth = 0;
  const layout = pages.map((page) => {
    const size = rotatedSize(page.widthPt, page.heightPt, page.rotation);
    const itemHeight = canvasPageItemHeight(page, scale, pageMargin);
    const item: CanvasPageLayout = {
      contentHeight: size.height * scale,
      contentWidth: size.width * scale,
      id: page.id,
      itemHeight,
      offset,
      pageTop,
    };
    offset += itemHeight;
    contentWidth = Math.max(contentWidth, item.contentWidth);
    return item;
  });
  return { docKey, pages: layout, totalHeight: offset, contentWidth };
}

/** Index of the page whose slot contains `offset` (clamped to the ends). */
export function pdfPageIndexAt(layout: CanvasSizingLayout, offset: number): number {
  const pages = layout.pages;
  if (pages.length === 0) return 0;
  if (offset <= 0) return 0;
  let low = 0;
  let high = pages.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    const page = pages[mid]!;
    if (offset < page.offset + page.itemHeight) high = mid;
    else low = mid + 1;
  }
  return low;
}

/**
 * The pages to keep mounted for a viewport: those intersecting it plus
 * `overscanPx` beyond each edge, and at least `minOverscanItems` more on
 * each side so a fast scroll meets a page that already rasterised.
 * `end` is exclusive.
 */
export function pdfVisiblePageRange(
  layout: CanvasSizingLayout,
  scrollTop: number,
  viewportHeight: number,
  overscanPx: number,
  minOverscanItems = 0,
): PageRange {
  const count = layout.pages.length;
  if (count === 0) return { start: 0, end: 0 };
  const top = Math.max(0, scrollTop - overscanPx);
  const bottom = scrollTop + Math.max(0, viewportHeight) + overscanPx;
  let start = pdfPageIndexAt(layout, top);
  let end = pdfPageIndexAt(layout, bottom) + 1;
  start = Math.max(0, start - minOverscanItems);
  end = Math.min(count, end + minOverscanItems);
  return { start, end };
}

/** scrollTop that puts the top of page `index` (plus `offsetInPage`) at the viewport top. */
export function pdfPageScrollTop(
  layout: CanvasSizingLayout,
  index: number,
  offsetInPage: number | null = null,
): number {
  const page = layout.pages[Math.max(0, Math.min(index, layout.pages.length - 1))];
  if (!page) return 0;
  if (offsetInPage === null) return page.offset;
  return page.offset + page.pageTop + offsetInPage;
}

function clampScrollTop(layout: CanvasSizingLayout, requested: number, viewportHeight: number): number {
  return Math.max(
    0,
    Math.min(
      Math.max(0, layout.totalHeight - Math.max(0, viewportHeight)),
      requested,
    ),
  );
}

/**
 * The scrollTop that returns the pinch anchor to where the fingers are:
 * `anchorPageY` is the anchored point measured from the page's top edge in
 * display pixels at the NEW scale, `anchorViewportY` where it must land
 * below the viewport top.
 */
export function canvasCommitScrollTop(
  next: CanvasSizingLayout,
  pageId: string,
  anchorPageY: number,
  anchorViewportY: number,
  viewportHeight: number,
): number | null {
  const page = next.pages.find((candidate) => candidate.id === pageId);
  if (!page) return null;
  const requested = page.offset + page.pageTop + anchorPageY - anchorViewportY;
  return clampScrollTop(next, requested, viewportHeight);
}

/**
 * For relayouts nobody anchored (fit-width after a resize, a margin change,
 * a rotation): keep whatever content sits at the viewport centre at the
 * centre. The point is located within its page — label gap, page body or
 * bottom margin — and re-projected proportionally into the new layout.
 */
export function remapScrollTop(
  previous: CanvasSizingLayout,
  next: CanvasSizingLayout,
  scrollTop: number,
  viewportHeight: number,
): number {
  if (previous.pages.length === 0 || next.pages.length === 0) return 0;
  const safeViewportHeight = Math.max(0, viewportHeight);
  const anchorOffset = Math.max(
    0,
    Math.min(previous.totalHeight, scrollTop + safeViewportHeight / 2),
  );
  const previousIndex = pdfPageIndexAt(previous, anchorOffset);
  const previousPage = previous.pages[previousIndex]!;
  const matchingIndex = next.pages.findIndex(
    (page) => page.id === previousPage.id,
  );
  const nextPage =
    next.pages[
      matchingIndex >= 0
        ? matchingIndex
        : Math.min(previousIndex, next.pages.length - 1)
    ]!;

  const localOffset = Math.max(
    0,
    Math.min(previousPage.itemHeight, anchorOffset - previousPage.offset),
  );
  const previousPageEnd = previousPage.pageTop + previousPage.contentHeight;
  let nextLocalOffset: number;
  if (localOffset < previousPage.pageTop) {
    const ratio =
      previousPage.pageTop > 0 ? localOffset / previousPage.pageTop : 0;
    nextLocalOffset = nextPage.pageTop * ratio;
  } else if (localOffset <= previousPageEnd) {
    const ratio =
      previousPage.contentHeight > 0
        ? (localOffset - previousPage.pageTop) / previousPage.contentHeight
        : 0;
    nextLocalOffset = nextPage.pageTop + nextPage.contentHeight * ratio;
  } else {
    const previousBottom = Math.max(0, previousPage.itemHeight - previousPageEnd);
    const nextBottom = Math.max(
      0,
      nextPage.itemHeight - nextPage.pageTop - nextPage.contentHeight,
    );
    const ratio =
      previousBottom > 0 ? (localOffset - previousPageEnd) / previousBottom : 0;
    nextLocalOffset =
      nextPage.pageTop + nextPage.contentHeight + nextBottom * ratio;
  }
  return clampScrollTop(
    next,
    nextPage.offset + nextLocalOffset - safeViewportHeight / 2,
    safeViewportHeight,
  );
}
