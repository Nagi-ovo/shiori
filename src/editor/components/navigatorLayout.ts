/**
 * Shape of the left gutter, kept out of the component file so the constants can
 * be imported by App and the icon rail without breaking fast refresh.
 */

export type NavigatorView = "documents" | "outline" | "pages" | "marks";

/**
 * Height of the header band that runs across the top of every column.
 *
 * The band is not a banner laid over the columns — it is each column's own
 * header, and they happen to be the same height, so their bottom borders join
 * into one line and the vertical dividers run from the very top of the window.
 * Tabs belong to the document column's segment of it, which is why they can
 * never reach over the sidebars.
 */
export const HEADER_BAND_HEIGHT = 40;

export const NAVIGATOR_DEFAULT_WIDTH = 236;
/**
 * Narrow enough to still be useful next to a page, wide enough that a paper
 * title is readable. Below the minimum the panel is only ellipses; above the
 * maximum the page it is meant to help you read stops fitting.
 */
export const NAVIGATOR_MIN_WIDTH = 170;
/**
 * Hard ceiling, but the real limit is the window: the gutter may never grow so
 * far that the page it exists to help you read stops fitting. A fixed 460 was
 * arbitrary and hit immediately on a wide display with long paper filenames.
 */
export const NAVIGATOR_MAX_WIDTH = 720;
/** Left for the page beside it — mirrors the right rail's own reservation. */
const PAGE_RESERVE_PX = 420;

/**
 * The right rail's floor, and therefore what the navigator owes it while it
 * is an in-flow column. It lives here rather than in RightRail because both
 * gutters have to budget against the same window: the rail already yields to
 * the navigator down to this width and no further, so if the navigator does
 * not yield back, the document column absorbs the entire shortfall.
 */
export const RAIL_MIN_WIDTH = 360;

/**
 * @param railReservePx width the right rail is holding, when it is an in-flow
 *   column. Zero when it is closed, a mobile drawer, or has no tab to show.
 * @param viewportWidth pass the value from `useViewportWidth()` so the clamp
 *   is recomputed when the window is resized. Reading `window.innerWidth`
 *   here is the fallback, and it is invisible to React on its own.
 */
export function clampNavigatorWidth(
  width: number,
  railReservePx = 0,
  viewportWidth = typeof window === "undefined"
    ? Number.POSITIVE_INFINITY
    : window.innerWidth,
): number {
  if (!Number.isFinite(width)) return NAVIGATOR_DEFAULT_WIDTH;
  const viewportLimit = Number.isFinite(viewportWidth)
    ? Math.max(
        NAVIGATOR_MIN_WIDTH,
        viewportWidth - PAGE_RESERVE_PX - railReservePx,
      )
    : NAVIGATOR_MAX_WIDTH;
  const ceiling = Math.min(NAVIGATOR_MAX_WIDTH, viewportLimit);
  return Math.round(Math.min(ceiling, Math.max(NAVIGATOR_MIN_WIDTH, width)));
}

