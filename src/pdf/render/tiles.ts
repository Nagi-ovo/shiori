import type { PdfDocument, PdfEngine } from "../engine/types";
import { assertCanvasPixelBudget, clampScaleToCanvasBudget } from "../openPolicy";

/**
 * Viewport tiles (docs/PLAN-RUST-PDF-CORE-2026-09.md, stage 1). A page whose
 * whole bitmap fits the backdrop budget (about 2× on a Retina Letter page)
 * keeps one full-page raster. Past it the page gets that backdrop plus sharp
 * tiles over the part the reader can see: past the canvas budget a single
 * bitmap could only be stretched, and between the two budgets tiles measured
 * twice as fast at under half the memory (docs/PERF-zoom-tiles.md, R1).
 */

/** Edge of one tile, in device pixels. */
export const TILE_PX = 512;

/**
 * Tiles kept around the visible ones in every direction, so a short scroll
 * lands on raster that is already sharp.
 */
export const TILE_RING = 1;

/**
 * The backdrop under the tiles: what shows while a tile renders and what a
 * fast scroll outruns. Low resolution on purpose — the tiles carry the
 * sharpness, and a budget-sized backdrop would be the 128 MB bitmap tiling
 * exists to avoid.
 */
export const TILED_BACKDROP_MAX_PIXELS = 8_000_000;

/** A rectangle in device pixels of the whole page raster. */
export type DeviceRect = { x: number; y: number; width: number; height: number };

export type TileCell = DeviceRect & {
  /** Stable for one scale, rotation and grid position. */
  key: string;
};

/** Whether a whole-page bitmap at `scale` would exceed the backdrop budget. */
export function pageNeedsTiles(
  widthPtAtScale1: number,
  heightPtAtScale1: number,
  scale: number,
  dpr: number,
): boolean {
  const budgetScale = clampScaleToCanvasBudget(
    scale,
    widthPtAtScale1,
    heightPtAtScale1,
    dpr,
    TILED_BACKDROP_MAX_PIXELS,
  );
  return budgetScale > 0 && budgetScale < scale;
}

/** The full-page raster size, in device pixels, at `scale`. */
export function pageDeviceSize(
  widthPtAtScale1: number,
  heightPtAtScale1: number,
  scale: number,
  dpr: number,
): { width: number; height: number } {
  return {
    width: Math.max(1, Math.floor(widthPtAtScale1 * scale * dpr)),
    height: Math.max(1, Math.floor(heightPtAtScale1 * scale * dpr)),
  };
}

/**
 * The grid cells to keep rendered: every tile that intersects the visible
 * part of the page, plus `ring` tiles around them, clipped to the page. Edge
 * tiles are cut to the page, so no tile paints past it.
 */
export function tilesToRender(input: {
  page: { width: number; height: number };
  visible: DeviceRect;
  tilePx?: number;
  ring?: number;
  /** Folded into each key, so a new scale never reuses an old tile. */
  keyPrefix?: string;
}): TileCell[] {
  const { page, visible } = input;
  const tilePx = input.tilePx ?? TILE_PX;
  const ring = input.ring ?? TILE_RING;
  const left = Math.max(0, visible.x);
  const top = Math.max(0, visible.y);
  const right = Math.min(page.width, visible.x + visible.width);
  const bottom = Math.min(page.height, visible.y + visible.height);
  if (right <= left || bottom <= top) return [];

  const lastCol = Math.ceil(page.width / tilePx) - 1;
  const lastRow = Math.ceil(page.height / tilePx) - 1;
  const firstCol = Math.max(0, Math.floor(left / tilePx) - ring);
  const firstRow = Math.max(0, Math.floor(top / tilePx) - ring);
  const endCol = Math.min(lastCol, Math.floor((right - 1) / tilePx) + ring);
  const endRow = Math.min(lastRow, Math.floor((bottom - 1) / tilePx) + ring);

  const cells: TileCell[] = [];
  for (let row = firstRow; row <= endRow; row += 1) {
    for (let col = firstCol; col <= endCol; col += 1) {
      const x = col * tilePx;
      const y = row * tilePx;
      cells.push({
        key: `${input.keyPrefix ?? ""}${col}:${row}`,
        x,
        y,
        width: Math.min(tilePx, page.width - x),
        height: Math.min(tilePx, page.height - y),
      });
    }
  }
  return cells;
}

const scrollParents = new WeakMap<HTMLElement, HTMLElement | null>();

/** The nearest ancestor that scrolls, which is what bounds what is on screen. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  if (scrollParents.has(el)) return scrollParents.get(el) ?? null;
  let found: HTMLElement | null = null;
  for (let p = el.parentElement; p; p = p.parentElement) {
    const style = getComputedStyle(p);
    if (/auto|scroll/.test(`${style.overflowX} ${style.overflowY}`)) {
      found = p;
      break;
    }
  }
  scrollParents.set(el, found);
  return found;
}

/**
 * The part of an element on screen — inside the window and inside the
 * scroller it lives in — in device pixels of its layout box.
 */
export function measureVisibleOnScreen(
  host: HTMLElement,
  dpr: number,
): DeviceRect | null {
  const rect = host.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  let left = Math.max(rect.left, 0);
  let top = Math.max(rect.top, 0);
  let right = Math.min(rect.right, window.innerWidth);
  let bottom = Math.min(rect.bottom, window.innerHeight);
  const scroller = scrollParent(host);
  if (scroller) {
    const box = scroller.getBoundingClientRect();
    left = Math.max(left, box.left);
    top = Math.max(top, box.top);
    right = Math.min(right, box.right);
    bottom = Math.min(bottom, box.bottom);
  }
  if (right <= left || bottom <= top) return null;
  // Layout size over on-screen size: a pinch preview scales the page with a
  // CSS transform, and tiles live in the untransformed box.
  const kx = (host.offsetWidth / rect.width) * dpr;
  const ky = (host.offsetHeight / rect.height) * dpr;
  return {
    x: (left - rect.left) * kx,
    y: (top - rect.top) * ky,
    width: (right - left) * kx,
    height: (bottom - top) * ky,
  };
}

/**
 * Draws a whole page as one bitmap no larger than `maxPixels`, through the
 * engine's region renderer. The canvas's CSS size is the page at `scale`, so a
 * bitmap clamped below that is stretched to the page (the tiles above it, if
 * any, carry the sharpness).
 */
export function renderPageBackdrop(
  renderRegion: PdfEngine["renderRegion"],
  doc: PdfDocument,
  page: {
    sourceIndex: number;
    rotation: number;
    scale: number;
    widthPt: number;
    heightPt: number;
    dpr: number;
    maxPixels: number;
    /** A sidebar thumbnail queues behind the page it stands for. */
    priority?: "backdrop" | "thumbnail";
  },
  canvas: HTMLCanvasElement,
): { cancel: () => void; done: Promise<void> } {
  const { sourceIndex, scale, widthPt, heightPt, dpr, maxPixels } = page;
  const clamped = clampScaleToCanvasBudget(scale, widthPt, heightPt, dpr, maxPixels);
  const bitmapScale = clamped > 0 ? clamped : scale;
  const size = pageDeviceSize(widthPt, heightPt, bitmapScale, dpr);
  assertCanvasPixelBudget(size.width, size.height);
  const handle = renderRegion(
    doc,
    {
      sourceIndex,
      rotation: page.rotation as 0 | 90 | 180 | 270,
      scale: bitmapScale,
      dpr,
      region: { x: 0, y: 0, ...size },
      priority: page.priority ?? "backdrop",
    },
    canvas,
  );
  return {
    cancel: handle.cancel,
    done: handle.done.then(() => {
      canvas.style.width = `${Math.max(1, Math.floor(widthPt * scale))}px`;
      canvas.style.height = `${Math.max(1, Math.floor(heightPt * scale))}px`;
    }),
  };
}
