import { describe, expect, test } from "bun:test";
import { displayToPdf, pdfToDisplay } from "../../pdf/geometry/coords";
import type { Rotation } from "../../pdf/model/types";
import type { FitMode } from "../store/store";
import {
  canvasSizingLayout,
  type CanvasPageSize,
  type CanvasSizingLayout,
} from "../components/pdfPageLayout";
import { MAX_ZOOM_SCALE } from "../zoomLimits";
import {
  createViewportController,
  type ClientRect,
  type ViewportController,
} from "./viewportController";

// What can go wrong keeping the PDF column's viewport:
//
// Resize and fit
// - every size change during a pane (rail / navigator) drag refits and
//   relayouts the column, per pixel of drag — the jank;
// - the drag ends and the size it ended on is never applied;
// - a resize that keeps the width refits anyway;
// - fit-width mode does not follow the column as it grows and shrinks;
// - a page rotated to landscape is fitted by its unrotated width and
//   overflows the column;
// - at a manual zoom a narrower column leaves the page cut off at its edge;
// - at a manual zoom a wider column enlarges the page, undoing a deliberate
//   zoom-out; a page that already fits is rescaled on a shrink;
// - double tap's fit-width target exists with no pages or no width.
//
// Layout landing
// - a newly opened document does not open on its active page;
// - a relayout nobody anchored (a fit, the margin preference) moves away
//   from what sits at the viewport centre;
// - the same layout landing twice moves the scroll.
//
// Zoom preview and commit
// - the point under the pointer moves on commit: the arithmetic target
//   alone misses the page's horizontal centring, and rotated pages have
//   their own display axes;
// - fingers drift during a pinch and the commit anchors at the start point;
// - a commit that does not change the scale relayouts anyway;
// - a commit with no page near the pointer lands nowhere (NaN, a throw);
// - the gesture flag or a preview transform survives a commit, a cancel or
//   an unmount;
// - a preview beyond the zoom limits commits beyond them;
// - with no preview layer mounted a session opens and never ends;
// - the controller keeps a scale of its own: the store's committed scale is
//   the only one, and the controller's visual scale outside a gesture is it.

type PageSpec = { widthPt?: number; heightPt?: number; rotation?: Rotation };

function pageList(specs: PageSpec[]): CanvasPageSize[] {
  return specs.map((spec, index) => ({
    id: `page-${index}`,
    widthPt: spec.widthPt ?? 612,
    heightPt: spec.heightPt ?? 792,
    rotation: spec.rotation ?? 0,
  }));
}

const SCROLLER = { left: 200, top: 60, width: 800, height: 600 };

/**
 * A browser for the controller: the page column laid out by the real layout
 * arithmetic, pages centred horizontally in a column at least as wide as the
 * scroller (what the CSS does), a scroller that clamps like a real one, and
 * preview layers that record their transform. Committing a scale relayouts
 * synchronously and lands the new layout, as Canvas's flushSync does.
 */
function fakeColumn(options: {
  pages: CanvasPageSize[];
  scale?: number;
  fitMode?: FitMode;
  isMobile?: boolean;
  activeIndex?: number;
  scrollTop?: number;
}) {
  const state = {
    pages: options.pages,
    scale: options.scale ?? 1,
    fitMode: options.fitMode ?? ("none" as FitMode),
    isMobile: options.isMobile ?? false,
    activePageId: options.pages[options.activeIndex ?? 0]?.id ?? null,
    top: 0,
    left: 0,
    layout: null as CanvasSizingLayout | null,
    gestureZooming: false,
    liveZoom: null as number | null,
    fitCalls: [] as number[],
    commits: [] as Array<{ scale: number; top: number }>,
    transforms: [] as string[],
    layersArmed: 0,
  };
  const layoutAt = (scale: number) =>
    canvasSizingLayout("doc", state.pages, scale, "Comfortable");
  const current = () => state.layout ?? layoutAt(state.scale);
  const columnWidth = () => Math.max(SCROLLER.width, current().contentWidth);
  const maxTop = () => Math.max(0, current().totalHeight - SCROLLER.height);
  const maxLeft = () => Math.max(0, columnWidth() - SCROLLER.width);
  const scroller = {
    get scrollTop() {
      return state.top;
    },
    set scrollTop(value: number) {
      state.top = Math.round(Math.max(0, Math.min(maxTop(), value)));
    },
    get scrollLeft() {
      return state.left;
    },
    set scrollLeft(value: number) {
      state.left = Math.round(Math.max(0, Math.min(maxLeft(), value)));
    },
    get clientHeight() {
      return SCROLLER.height;
    },
    getBoundingClientRect: (): ClientRect => ({ ...SCROLLER }),
  };
  const pageRect = (id: string): ClientRect => {
    const page = current().pages.find((candidate) => candidate.id === id)!;
    return {
      left: SCROLLER.left + (columnWidth() - page.contentWidth) / 2 - state.left,
      top: SCROLLER.top + page.offset + page.pageTop - state.top,
      width: page.contentWidth,
      height: page.contentHeight,
    };
  };
  const controller: ViewportController = createViewportController({
    scroller: () => scroller,
    pageRects: () => current().pages.map((page) => ({ id: page.id, rect: pageRect(page.id) })),
    armPreviewLayers: () => {
      state.layersArmed += 1;
      return [
        {
          left: SCROLLER.left - state.left,
          top: SCROLLER.top - state.top,
          transform: (x, y, ratio) => {
            state.transforms.push(`${x.toFixed(1)},${y.toFixed(1)},${ratio.toFixed(3)}`);
          },
          restore: () => {
            state.transforms.push("restored");
          },
        },
      ];
    },
    pages: () => state.pages,
    layoutAt,
    activePageId: () => state.activePageId,
    scale: () => state.scale,
    fitMode: () => state.fitMode,
    isMobile: () => state.isMobile,
    fitScale: (scale) => {
      state.fitCalls.push(scale);
      state.scale = scale;
    },
    commitScale: (scale, top) => {
      state.commits.push({ scale, top });
      state.scale = scale;
      relayout();
    },
    syncRange: () => undefined,
    setGestureZooming: (on) => {
      state.gestureZooming = on;
    },
    showLiveZoom: (scale) => {
      state.liveZoom = scale;
    },
    debug: () => undefined,
  });
  /** What Canvas's layout effect does on a new layout. */
  function relayout() {
    state.layout = layoutAt(state.scale);
    controller.land(state.layout);
  }
  relayout();
  if (options.scrollTop !== undefined) scroller.scrollTop = options.scrollTop;

  /** The PDF point under a client point, on the page that holds it. */
  function pdfPointAt(x: number, y: number) {
    for (const page of state.pages) {
      const rect = pageRect(page.id);
      if (x < rect.left || x > rect.left + rect.width) continue;
      if (y < rect.top || y > rect.top + rect.height) continue;
      return {
        pageId: page.id,
        point: displayToPdf(
          { x: x - rect.left, y: y - rect.top },
          page.widthPt,
          page.heightPt,
          page.rotation,
          state.scale,
        ),
      };
    }
    throw new Error(`no page under ${x},${y}`);
  }
  /** Where a PDF point on a page sits in client coordinates now. */
  function clientPointOf(at: { pageId: string; point: { x: number; y: number } }) {
    const page = state.pages.find((candidate) => candidate.id === at.pageId)!;
    const rect = pageRect(page.id);
    const display = pdfToDisplay(at.point, page.widthPt, page.heightPt, page.rotation, state.scale);
    return { x: rect.left + display.x, y: rect.top + display.y };
  }
  return { controller, state, scroller, layoutAt, relayout, pdfPointAt, clientPointOf };
}

const eightPages = () => pageList(Array.from({ length: 8 }, () => ({})));

describe("resize and fit", () => {
  test("fit-width follows the column both ways", () => {
    const { controller, state } = fakeColumn({ pages: eightPages(), fitMode: "width" });
    controller.resize({ width: 1172, height: 900 }, false);
    expect(state.scale).toBe(1.654);
    controller.resize({ width: 772, height: 900 }, false);
    expect(state.scale).toBe(1);
  });

  test("a page rotated to landscape is fitted by its rotated width", () => {
    const pages = pageList([{}, { rotation: 90 }]);
    const { controller, state } = fakeColumn({ pages, fitMode: "width" });
    controller.resize({ width: 952, height: 900 }, false);
    // The rotated page is 792 pt wide on screen; 612 would overflow it.
    expect(state.scale).toBe(1);
  });

  test("at a manual zoom the page shrinks with the column, never grows", () => {
    const { controller, state } = fakeColumn({ pages: eightPages(), scale: 1.5 });
    controller.resize({ width: 1200, height: 900 }, false);
    expect(state.scale).toBe(1.5);
    // The rail opens: the column narrows below the page.
    controller.resize({ width: 772, height: 900 }, false);
    expect(state.scale).toBe(1);
    // The rail closes: the deliberate zoom is not restored.
    controller.resize({ width: 1200, height: 900 }, false);
    expect(state.scale).toBe(1);
  });

  test("at a manual zoom that already fits, a narrower column changes nothing", () => {
    const { controller, state } = fakeColumn({ pages: eightPages(), scale: 0.8 });
    controller.resize({ width: 1200, height: 900 }, false);
    controller.resize({ width: 900, height: 900 }, false);
    expect(state.scale).toBe(0.8);
    expect(state.fitCalls).toEqual([]);
  });

  test("sizes are parked during a pane drag and the last one applies once", () => {
    const { controller, state } = fakeColumn({ pages: eightPages(), fitMode: "width" });
    controller.resize({ width: 1172, height: 900 }, false);
    const before = state.fitCalls.length;
    for (const width of [1100, 1000, 900, 852]) {
      expect(controller.resize({ width, height: 900 }, true)).toBe(false);
    }
    expect(state.fitCalls.length).toBe(before);
    expect(controller.paneDragEnded()).toBe(true);
    expect(state.fitCalls.slice(before)).toEqual([1.131]);
  });

  test("a drag that ends without a size applies nothing", () => {
    const { controller, state } = fakeColumn({ pages: eightPages(), fitMode: "width" });
    expect(controller.paneDragEnded()).toBe(false);
    expect(state.fitCalls).toEqual([]);
  });

  test("a resize that keeps the width does not refit", () => {
    const { controller, state } = fakeColumn({ pages: eightPages(), fitMode: "width" });
    controller.resize({ width: 1172, height: 900 }, false);
    controller.resize({ width: 1172, height: 700 }, false);
    expect(state.fitCalls).toEqual([1.654]);
  });

  test("refit applies fit-width to the current column when the mode returns to it", () => {
    const { controller, state } = fakeColumn({ pages: eightPages(), scale: 2 });
    controller.resize({ width: 1172, height: 900 }, false);
    state.fitMode = "width";
    controller.refit();
    expect(state.scale).toBe(1.654);
  });

  test("the fit-width target for a double tap", () => {
    const { controller } = fakeColumn({ pages: pageList([{}, { widthPt: 900 }]) });
    controller.resize({ width: 1060, height: 900 }, false);
    expect(controller.fitWidthScale()).toBe(1);
    expect(fakeColumn({ pages: [] }).controller.fitWidthScale()).toBeNull();
  });
});

describe("layout landing", () => {
  test("a document opens on its active page", () => {
    const { state, layoutAt } = fakeColumn({ pages: eightPages(), activeIndex: 4 });
    expect(state.top).toBe(layoutAt(1).pages[4]!.offset);
  });

  test("a relayout nobody anchored keeps the content at the viewport centre", () => {
    const { state, scroller, relayout, pdfPointAt, clientPointOf } = fakeColumn({
      pages: eightPages(),
      scrollTop: 2000,
    });
    const centre = pdfPointAt(SCROLLER.left + 400, SCROLLER.top + 300);
    // A fit changes the layout under the reader.
    state.scale = 1.3;
    relayout();
    const moved = clientPointOf(centre);
    expect(Math.abs(moved.y - (SCROLLER.top + 300))).toBeLessThanOrEqual(1);
    expect(scroller.scrollTop).not.toBe(2000);
  });

  // A document opens (or a session restores) on its active page before the
  // column has its size; the fits that follow are relayouts nobody
  // anchored, and keeping the viewport centre through them slid the
  // restored page's top out of view (515 px at a 2.1x fit).
  test("an opened page keeps its top through the fits that follow", () => {
    const column = fakeColumn({ pages: eightPages(), activeIndex: 4 });
    for (const fit of [1.046, 2.127]) {
      column.state.scale = fit;
      column.relayout();
      expect(column.scroller.scrollTop).toBe(Math.round(column.layoutAt(fit).pages[4]!.offset));
    }
  });

  test("an opened last page stays in view through a fit", () => {
    const column = fakeColumn({ pages: eightPages(), activeIndex: 7 });
    column.state.scale = 1.6;
    column.relayout();
    const layout = column.layoutAt(1.6);
    expect(column.scroller.scrollTop).toBe(
      Math.round(Math.min(layout.pages[7]!.offset, layout.totalHeight - SCROLLER.height)),
    );
  });

  test("once the reader scrolls, a fit keeps the viewport centre again", () => {
    const column = fakeColumn({ pages: eightPages(), activeIndex: 4 });
    const landing = column.scroller.scrollTop;
    column.scroller.scrollTop += 300;
    column.controller.onScroll();
    column.scroller.scrollTop = landing;
    column.controller.onScroll();
    const centre = column.pdfPointAt(SCROLLER.left + 400, SCROLLER.top + 300);
    column.state.scale = 1.4;
    column.relayout();
    const moved = column.clientPointOf(centre);
    expect(Math.abs(moved.y - (SCROLLER.top + 300))).toBeLessThanOrEqual(1);
  });

  test("landing the same layout twice leaves the scroll alone", () => {
    const { controller, state, scroller } = fakeColumn({ pages: eightPages(), scrollTop: 1234 });
    expect(controller.land(state.layout!)).toBe(false);
    expect(scroller.scrollTop).toBe(1234);
  });
});

describe("zoom preview and commit", () => {
  function pinch(
    column: ReturnType<typeof fakeColumn>,
    frames: Array<{ x: number; y: number; scale: number }>,
  ) {
    for (const frame of frames) column.controller.preview({ x: frame.x, y: frame.y }, frame.scale);
    column.controller.commitPreview();
  }

  test("the PDF point under the pointer stays under it", () => {
    const column = fakeColumn({ pages: eightPages(), scrollTop: 2600 });
    const at = { x: SCROLLER.left + 520, y: SCROLLER.top + 210 };
    const point = column.pdfPointAt(at.x, at.y);
    pinch(column, [
      { ...at, scale: 1.4 },
      { ...at, scale: 2.2 },
    ]);
    expect(column.state.scale).toBe(2.2);
    const landed = column.clientPointOf(point);
    expect(Math.abs(landed.x - at.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(landed.y - at.y)).toBeLessThanOrEqual(1);
  });

  test("on a rotated page the PDF point under the pointer stays under it", () => {
    const pages = pageList([{}, { rotation: 90 }, { rotation: 270 }, {}]);
    for (const pageIndex of [1, 2]) {
      const column = fakeColumn({ pages });
      const page = column.layoutAt(1).pages[pageIndex]!;
      column.scroller.scrollTop = page.offset + 100;
      const at = { x: SCROLLER.left + 300, y: SCROLLER.top + 250 };
      const point = column.pdfPointAt(at.x, at.y);
      expect(point.pageId).toBe(`page-${pageIndex}`);
      pinch(column, [{ ...at, scale: 2.5 }]);
      const landed = column.clientPointOf(point);
      expect(Math.abs(landed.x - at.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(landed.y - at.y)).toBeLessThanOrEqual(1);
    }
  });

  test("the commit anchors where the fingers ended, not where they began", () => {
    const column = fakeColumn({ pages: eightPages(), scrollTop: 2600 });
    const end = { x: SCROLLER.left + 560, y: SCROLLER.top + 330 };
    const point = column.pdfPointAt(end.x, end.y);
    pinch(column, [
      { x: SCROLLER.left + 380, y: SCROLLER.top + 200, scale: 1.3 },
      { ...end, scale: 1.9 },
    ]);
    const landed = column.clientPointOf(point);
    expect(Math.abs(landed.x - end.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(landed.y - end.y)).toBeLessThanOrEqual(1);
  });

  test("the preview transforms about the pointer and is restored on commit", () => {
    const column = fakeColumn({ pages: eightPages(), scrollTop: 0 });
    column.controller.preview({ x: 600, y: 360 }, 2);
    expect(column.state.gestureZooming).toBe(true);
    expect(column.state.liveZoom).toBe(2);
    // translate = (pointer - layer origin) × (1 − ratio)
    expect(column.state.transforms).toEqual(["-400.0,-300.0,2.000"]);
    column.controller.commitPreview();
    expect(column.state.transforms.at(-1)).toBe("restored");
    expect(column.state.gestureZooming).toBe(false);
    expect(column.state.liveZoom).toBeNull();
    expect(column.controller.isGesturing()).toBe(false);
  });

  test("a commit that keeps the scale does not relayout or scroll", () => {
    const column = fakeColumn({ pages: eightPages(), scale: 1.5, scrollTop: 900 });
    pinch(column, [
      { x: 600, y: 360, scale: 1.8 },
      { x: 600, y: 360, scale: 1.5004 },
    ]);
    expect(column.state.commits).toEqual([]);
    expect(column.scroller.scrollTop).toBe(900);
    expect(column.state.gestureZooming).toBe(false);
  });

  test("a preview beyond the limits commits at the limit", () => {
    const column = fakeColumn({ pages: eightPages(), scrollTop: 900 });
    pinch(column, [{ x: 600, y: 360, scale: 40 }]);
    expect(column.state.scale).toBe(MAX_ZOOM_SCALE);
  });

  test("with no page near the pointer the commit still lands", () => {
    const column = fakeColumn({ pages: [] });
    column.controller.preview({ x: 600, y: 360 }, 2);
    column.controller.commitPreview();
    expect(column.state.scale).toBe(2);
    expect(Number.isFinite(column.scroller.scrollTop)).toBe(true);
    expect(Number.isFinite(column.scroller.scrollLeft)).toBe(true);
  });

  test("cancel restores the preview and ends the gesture without a commit", () => {
    const column = fakeColumn({ pages: eightPages(), scrollTop: 900 });
    column.controller.preview({ x: 600, y: 360 }, 2);
    column.controller.cancelPreview();
    expect(column.state.transforms.at(-1)).toBe("restored");
    expect(column.state.commits).toEqual([]);
    expect(column.state.gestureZooming).toBe(false);
    expect(column.controller.isPreviewing()).toBe(false);
    expect(column.controller.visualScale()).toBe(1);
  });

  test("dispose restores a live preview", () => {
    const column = fakeColumn({ pages: eightPages(), scrollTop: 900 });
    column.controller.preview({ x: 600, y: 360 }, 2);
    column.controller.dispose();
    expect(column.state.transforms.at(-1)).toBe("restored");
    expect(column.controller.isPreviewing()).toBe(false);
  });

  test("with no preview layer mounted no session opens", () => {
    const column = fakeColumn({ pages: eightPages() });
    const controller = createViewportController({
      scroller: () => column.scroller,
      pageRects: () => [],
      armPreviewLayers: () => [],
      pages: () => column.state.pages,
      layoutAt: column.layoutAt,
      activePageId: () => null,
      scale: () => column.state.scale,
      fitMode: () => "none",
      isMobile: () => false,
      fitScale: () => undefined,
      commitScale: () => undefined,
      syncRange: () => undefined,
      setGestureZooming: (on) => {
        column.state.gestureZooming = on;
      },
      showLiveZoom: () => undefined,
      debug: () => undefined,
    });
    controller.preview({ x: 600, y: 360 }, 2);
    expect(controller.isPreviewing()).toBe(false);
    expect(controller.isGesturing()).toBe(false);
    expect(column.state.gestureZooming).toBe(false);
  });

  test("the store's scale is the only committed scale", () => {
    const column = fakeColumn({ pages: eightPages(), scrollTop: 900 });
    column.controller.preview({ x: 600, y: 360 }, 1.7);
    expect(column.controller.visualScale()).toBe(1.7);
    column.controller.commitPreview();
    expect(column.state.commits.map((commit) => commit.scale)).toEqual([1.7]);
    // A zoom from anywhere else (toolbar, keys, a fit) is what the
    // controller reports from then on.
    column.state.scale = 0.9;
    expect(column.controller.visualScale()).toBe(0.9);
  });
});
