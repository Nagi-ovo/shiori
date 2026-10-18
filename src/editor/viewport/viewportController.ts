import { displayToPdf, pdfToDisplay, rotatedSize } from "../../pdf/geometry/coords";
import type { PdfPoint } from "../../pdf/model/types";
import type { FitMode } from "../store/store";
import {
  canvasCommitScrollTop,
  pdfPageScrollTop,
  remapScrollTop,
  type CanvasPageSize,
  type CanvasSizingLayout,
} from "../components/pdfPageLayout";
import { MAX_ZOOM_SCALE, MIN_ZOOM_SCALE } from "../zoomLimits";

/**
 * The PDF column's viewport: the column's size and the fit it implies, where
 * each new layout lands, and the zoom preview and its commit. Canvas binds
 * the ports to the DOM and the store; the controller never imports React.
 *
 * The store's `scale` is the only committed zoom. The controller holds only
 * a live preview's visual scale, and outside a preview reports the store's.
 * Zoom anchors are a page and a point in PDF user space (AGENTS.md fact 1),
 * so they survive the page's rotation and the change of scale.
 */

export type ClientRect = { left: number; top: number; width: number; height: number };

/** The scrolling element; an HTMLElement satisfies it. */
export type ScrollerPort = {
  scrollTop: number;
  scrollLeft: number;
  readonly clientHeight: number;
  getBoundingClientRect(): ClientRect;
};

/** One armed preview layer: its client origin when armed, and its transform. */
export type PreviewLayer = {
  left: number;
  top: number;
  transform(translateX: number, translateY: number, ratio: number): void;
  restore(): void;
};

export type ViewportPorts = {
  scroller(): ScrollerPort | null;
  /** The mounted pages' bodies in client coordinates. */
  pageRects(): Array<{ id: string; rect: ClientRect }>;
  /** Arms every preview layer for a compositor-only preview. */
  armPreviewLayers(): PreviewLayer[];
  pages(): readonly CanvasPageSize[];
  layoutAt(scale: number): CanvasSizingLayout;
  activePageId(): string | null;
  /** The store's committed scale. */
  scale(): number;
  fitMode(): FitMode;
  isMobile(): boolean;
  /** Sets the scale a fit chose, keeping the fit mode. */
  fitScale(scale: number): void;
  /**
   * Commits a zoom: the store's scale and the mounted range for `scrollTop`,
   * flushed synchronously so the new layout has landed when this returns.
   */
  commitScale(scale: number, scrollTop: number): void;
  /** Re-derives the mounted pages from the scroller's position. */
  syncRange(): void;
  setGestureZooming(on: boolean): void;
  showLiveZoom(scale: number | null): void;
  debug(kind: string, data: Record<string, unknown>): void;
};

export type ViewportController = {
  /** A column size from the ResizeObserver; parked while a pane is dragged. True when applied. */
  resize(size: { width: number; height: number }, paneDragging: boolean): boolean;
  /** Applies the size parked during a pane drag. True when there was one. */
  paneDragEnded(): boolean;
  /** Re-applies fit-width after the fit mode, the pages or the device class changed. */
  refit(): void;
  /** The fit-width scale for the current column (double tap returns to it). */
  fitWidthScale(): number | null;
  /** Lands a new layout before it paints. False when it was already landed. */
  land(layout: CanvasSizingLayout): boolean;
  onScroll(): void;
  /** One preview frame: the column drawn at `scale`, fixed at `point`. */
  preview(point: { x: number; y: number }, scale: number): void;
  commitPreview(): void;
  cancelPreview(): void;
  /** The live preview's scale, else the store's. */
  visualScale(): number;
  isPreviewing(): boolean;
  /** True from a preview's first frame until its commit or cancel. */
  isGesturing(): boolean;
  /** Restores a live preview (the canvas is unmounting). */
  dispose(): void;
};

type PageAnchor = { pageId: string; point: PdfPoint };

type PreviewSession = {
  anchorX: number;
  anchorY: number;
  baseScale: number;
  visual: number;
  contentX: number;
  contentY: number;
  layers: PreviewLayer[];
  pageAnchor: PageAnchor | null;
};

// Before the column reports its size.
const INITIAL_WIDTH = 800;

export function createViewportController(ports: ViewportPorts): ViewportController {
  let width = INITIAL_WIDTH;
  let parked: { width: number; height: number } | null = null;
  let applied: CanvasSizingLayout | null = null;
  // The scrollTop the next layout lands on, set by a zoom commit right
  // before it flushes the new scale.
  let commitTarget: number | null = null;
  // The page a new document opened on, and the scrollTop that landing left.
  // While the scroller still sits there the reader has not moved, and the
  // fits that follow opening (the column learning its width) re-land on that
  // page's top. Keeping the viewport centre through them instead slid the
  // page's top out of view by (centre offset × fit ratio). A scroll moves
  // the scroller off this position and releases the pin.
  let pinned: { pageId: string; top: number } | null = null;
  let session: PreviewSession | null = null;
  let gesturing = false;

  function widestPage(): number {
    return ports.pages().reduce((max, page) => {
      const size = rotatedSize(page.widthPt, page.heightPt, page.rotation);
      return Math.max(max, size.width);
    }, 0);
  }

  function fitWidthScale(): number | null {
    const widest = widestPage();
    return widest > 0 && width > 0 ? fitWidth(width, widest, ports.isMobile()) : null;
  }

  function applyFitWidth() {
    if (ports.fitMode() === "none") return;
    const fit = fitWidthScale();
    if (fit !== null) ports.fitScale(fit);
  }

  function setWidth(next: number) {
    if (next === width) return;
    const previous = width;
    width = next;
    applyFitWidth();
    // At a manual zoom a narrower column (the right rail opening) left the
    // page wider than the space, cut off at the rail's edge. Scale it down
    // to fit, only on a shrink and only downward: growing it back when the
    // rail closes would undo a deliberate zoom-out.
    if (ports.fitMode() !== "none") return;
    if (next <= 0 || next >= previous) return;
    const fitting = fitWidthScale();
    if (fitting === null || ports.scale() <= fitting) return;
    ports.fitScale(fitting);
  }

  /** The page under (or nearest to) a client point, and the PDF point there. */
  function anchorAt(x: number, y: number, scale: number): PageAnchor | null {
    let best: { id: string; rect: ClientRect; distance: number } | null = null;
    for (const { id, rect } of ports.pageRects()) {
      const right = rect.left + rect.width;
      const bottom = rect.top + rect.height;
      const dx = x < rect.left ? rect.left - x : x > right ? x - right : 0;
      const dy = y < rect.top ? rect.top - y : y > bottom ? y - bottom : 0;
      const distance = Math.hypot(dx, dy);
      if (!best || distance < best.distance) best = { id, rect, distance };
    }
    if (!best) return null;
    const page = ports.pages().find((candidate) => candidate.id === best.id);
    if (!page) return null;
    return {
      pageId: best.id,
      point: displayToPdf(
        { x: x - best.rect.left, y: y - best.rect.top },
        page.widthPt,
        page.heightPt,
        page.rotation,
        scale,
      ),
    };
  }

  /** Where an anchor sits on its page's body at `scale`, in display pixels. */
  function anchorOnPage(anchor: PageAnchor, scale: number): { x: number; y: number } | null {
    const page = ports.pages().find((candidate) => candidate.id === anchor.pageId);
    if (!page) return null;
    return pdfToDisplay(anchor.point, page.widthPt, page.heightPt, page.rotation, scale);
  }

  function beginPreview(x: number, y: number): PreviewSession | null {
    if (session) return session;
    const scroller = ports.scroller();
    if (!scroller) return null;
    const layers = ports.armPreviewLayers();
    if (layers.length === 0) return null;
    const scrollerRect = scroller.getBoundingClientRect();
    const baseScale = ports.scale();
    const next: PreviewSession = {
      anchorX: x,
      anchorY: y,
      baseScale,
      visual: baseScale,
      contentX: scroller.scrollLeft + x - scrollerRect.left,
      contentY: scroller.scrollTop + y - scrollerRect.top,
      layers,
      pageAnchor: anchorAt(x, y, baseScale),
    };
    ports.debug("sessionBegin", {
      base: baseScale,
      x,
      y,
      layers: layers.length,
      anchorId: next.pageAnchor?.pageId ?? null,
      scrollTop: Math.round(scroller.scrollTop),
      scrollLeft: Math.round(scroller.scrollLeft),
    });
    session = next;
    gesturing = true;
    ports.setGestureZooming(true);
    return next;
  }

  function restoreLayers(ended: PreviewSession) {
    for (const layer of ended.layers) layer.restore();
  }

  return {
    resize(size, paneDragging) {
      parked = size;
      if (paneDragging) return false;
      setWidth(size.width);
      return true;
    },

    paneDragEnded() {
      if (!parked) return false;
      setWidth(parked.width);
      return true;
    },

    refit: applyFitWidth,

    fitWidthScale,

    land(layout) {
      const scroller = ports.scroller();
      const previous = applied;
      applied = layout;
      if (!scroller || previous === layout) return false;
      const target = commitTarget;
      commitTarget = null;
      const pinnedIndex =
        pinned !== null && Math.abs(scroller.scrollTop - pinned.top) <= 1
          ? layout.pages.findIndex((page) => page.id === pinned?.pageId)
          : -1;
      let top: number;
      let pin: string | null = null;
      if (target !== null) {
        top = target;
      } else if (previous === null || previous.docKey !== layout.docKey) {
        // A new document opens on its active page.
        const activeId = ports.activePageId();
        const index = Math.max(0, layout.pages.findIndex((page) => page.id === activeId));
        top = pdfPageScrollTop(layout, index);
        pin = layout.pages[index]?.id ?? null;
      } else if (pinnedIndex >= 0) {
        top = pdfPageScrollTop(layout, pinnedIndex);
        pin = layout.pages[pinnedIndex]!.id;
      } else {
        // A relayout nobody anchored keeps the viewport centre.
        top = remapScrollTop(previous, layout, scroller.scrollTop, scroller.clientHeight);
      }
      scroller.scrollTop = top;
      // Read back: the scroller clamps a landing past the document's end.
      pinned = pin === null ? null : { pageId: pin, top: scroller.scrollTop };
      return true;
    },

    onScroll() {
      const scroller = ports.scroller();
      if (pinned && scroller && Math.abs(scroller.scrollTop - pinned.top) > 1) pinned = null;
    },

    preview(point, scale) {
      const live = beginPreview(point.x, point.y);
      if (!live) return;
      const clamped = clamp(scale, MIN_ZOOM_SCALE, MAX_ZOOM_SCALE);
      live.visual = clamped;
      ports.showLiveZoom(clamped);
      live.anchorX = point.x;
      live.anchorY = point.y;
      ports.debug("frame", {
        target: Math.round(clamped * 1000) / 1000,
        x: Math.round(point.x),
        y: Math.round(point.y),
      });
      const ratio = clamped / live.baseScale;
      for (const layer of live.layers) {
        layer.transform(
          (point.x - layer.left) * (1 - ratio),
          (point.y - layer.top) * (1 - ratio),
          ratio,
        );
      }
    },

    commitPreview() {
      const ended = session;
      session = null;
      ports.showLiveZoom(null);
      if (!ended) {
        gesturing = false;
        ports.setGestureZooming(false);
        return;
      }
      const nextScale = Number(clamp(ended.visual, MIN_ZOOM_SCALE, MAX_ZOOM_SCALE).toFixed(3));
      ports.debug("commitStart", {
        next: nextScale,
        base: ended.baseScale,
        cx: Math.round(ended.anchorX),
        cy: Math.round(ended.anchorY),
      });
      const scaleChanged = Math.abs(nextScale - ended.baseScale) >= 0.001;
      restoreLayers(ended);
      // The preview's fixed point is whatever sits under the LAST pointer
      // position: finger drift pans the document, so the session-start
      // anchor no longer describes what the reader is looking at. With the
      // transforms restored and scroll untouched the base layout is back;
      // re-derive the anchor from it so the committed layout continues
      // where the preview's last frame left off. Pinning the start anchor
      // shifted the view by (finger drift × zoom ratio) on release.
      const finalAnchor = anchorAt(ended.anchorX, ended.anchorY, ended.baseScale);
      ports.debug("reAnchor", { id: finalAnchor?.pageId ?? null });
      if (finalAnchor) ended.pageAnchor = finalAnchor;
      const scroller = ports.scroller();
      if (scroller) {
        const rect = scroller.getBoundingClientRect();
        ended.contentX = scroller.scrollLeft + ended.anchorX - rect.left;
        ended.contentY = scroller.scrollTop + ended.anchorY - rect.top;
      }
      gesturing = false;
      if (!scaleChanged) {
        ports.setGestureZooming(false);
        return;
      }

      // One synchronous commit: the new scale re-lays the same mounted
      // pages, the landing puts scrollTop on the anchor-pinned target, and
      // the residual (horizontal centring, sub-pixel rounding) is corrected
      // from the real page rectangle — all before this frame paints.
      const ratio = nextScale / ended.baseScale;
      const anchor = ended.pageAnchor;
      const preCommitRect = scroller?.getBoundingClientRect() ?? null;
      const nextLayout = ports.layoutAt(nextScale);
      const viewportHeight = scroller?.clientHeight ?? 0;
      const onPage = anchor ? anchorOnPage(anchor, nextScale) : null;
      const target =
        anchor && onPage && preCommitRect
          ? canvasCommitScrollTop(
              nextLayout,
              anchor.pageId,
              onPage.y,
              ended.anchorY - preCommitRect.top,
              viewportHeight,
            )
          : null;
      const seeded =
        target ??
        Math.max(0, ended.contentY * ratio - (ended.anchorY - (preCommitRect?.top ?? 0)));
      commitTarget = seeded;
      ports.setGestureZooming(false);
      ports.commitScale(nextScale, seeded);
      commitTarget = null;

      const nextScroller = ports.scroller();
      if (!nextScroller) return;
      const pageRect =
        anchor && onPage
          ? (ports.pageRects().find((page) => page.id === anchor.pageId)?.rect ?? null)
          : null;
      if (onPage && pageRect) {
        nextScroller.scrollLeft += pageRect.left + onPage.x - ended.anchorX;
        nextScroller.scrollTop += pageRect.top + onPage.y - ended.anchorY;
      } else {
        const nextRect = nextScroller.getBoundingClientRect();
        nextScroller.scrollLeft = ended.contentX * ratio - (ended.anchorX - nextRect.left);
      }
      ports.syncRange();
      ports.debug("commitApplied", {
        target: Math.round(seeded),
        top: Math.round(nextScroller.scrollTop),
        left: Math.round(nextScroller.scrollLeft),
        anchorMounted: Boolean(pageRect),
      });
    },

    cancelPreview() {
      const ended = session;
      session = null;
      if (ended) restoreLayers(ended);
      ports.showLiveZoom(null);
      gesturing = false;
      ports.setGestureZooming(false);
    },

    visualScale: () => session?.visual ?? ports.scale(),

    isPreviewing: () => session !== null,

    isGesturing: () => gesturing,

    dispose() {
      const ended = session;
      session = null;
      if (ended) restoreLayers(ended);
      ports.showLiveZoom(null);
    },
  };
}

// Fit-width: the widest page fills the column minus a gutter. The phone
// gutter is the page's breathing room only; the desktop one leaves the
// page-number rail and thumbnails' shadow clear.
function fitWidth(containerWidth: number, widestPagePt: number, isMobile: boolean): number {
  const gutter = isMobile ? 24 : 160;
  return Number(Math.max(0.25, (containerWidth - gutter) / widestPagePt).toFixed(3));
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
