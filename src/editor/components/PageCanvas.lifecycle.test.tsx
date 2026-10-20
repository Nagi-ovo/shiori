import "../../test/setupDom";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import i18n from "../../i18n";
import type { PdfDocument as PDFDocumentProxy } from "../../pdf/engine/types";

const cancelRender = mock(() => undefined);
const rasteredScales: number[] = [];
/** Each backdrop's bitmap width, in device pixels. */
const rasteredWidths: number[] = [];

type TileRequest = {
  x: number;
  y: number;
  scale: number;
  canvas: HTMLCanvasElement;
  cancelled: boolean;
  finish: () => void;
  fail: () => void;
};
const tileRequests: TileRequest[] = [];
/** What the fake window shows of the page, in device pixels. */
let visible: { x: number; y: number; width: number; height: number } | null = null;

const runtime = {
  releaseCanvasBackingStore: (canvas: HTMLCanvasElement | null) => {
    if (!canvas) return;
    canvas.width = 0;
    canvas.height = 0;
  },
  getPagePreview: () => null,
  storePagePreview: () => undefined,
  renderRegion: (
    _doc: unknown,
    request: {
      scale: number;
      priority?: string;
      region: { x: number; y: number; width: number; height: number };
    },
    canvas: HTMLCanvasElement,
  ) => {
    // The full-page backdrop: drawn at once.
    if (request.priority === "backdrop") {
      rasteredScales.push(request.scale);
      rasteredWidths.push(request.region.width);
      canvas.width = request.region.width;
      canvas.height = request.region.height;
      return { cancel: cancelRender, done: Promise.resolve() };
    }
    let finish = () => {};
    let fail = () => {};
    const done = new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = () => reject(new Error("region rejected"));
    });
    const tile: TileRequest = {
      x: request.region.x,
      y: request.region.y,
      scale: request.scale,
      canvas,
      cancelled: false,
      finish: () => {
        canvas.width = request.region.width;
        canvas.height = request.region.height;
        finish();
      },
      fail,
    };
    tileRequests.push(tile);
    return {
      cancel: () => {
        tile.cancelled = true;
      },
      done,
    };
  },
  measureVisible: () => visible,
};

const { PageCanvas } = await import("./PageCanvas");

function setDpr(dpr: number) {
  Object.defineProperty(window, "devicePixelRatio", {
    configurable: true,
    value: dpr,
  });
}

/**
 * A screen whose pixel ratio can change under a mounted page (the window
 * moved to another monitor): `(resolution: …)` queries report the change.
 */
function watchResolutionQueries() {
  const listeners = new Set<EventListener>();
  const original = window.matchMedia;
  window.matchMedia = ((media: string) => ({
    matches: true,
    media,
    onchange: null,
    addEventListener: (_type: string, listener: EventListener) => listeners.add(listener),
    removeEventListener: (_type: string, listener: EventListener) => listeners.delete(listener),
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => true,
  })) as unknown as typeof window.matchMedia;
  restoreMatchMedia = () => {
    window.matchMedia = original;
  };
  return (dpr: number) => {
    setDpr(dpr);
    act(() => {
      for (const listener of [...listeners]) listener(new Event("change"));
    });
  };
}
let restoreMatchMedia = () => {};

const pause = (ms: number) =>
  new Promise((resolve) => window.setTimeout(resolve, ms));

const letterDoc = {} as PDFDocumentProxy;

/** A Letter page on a Retina screen, scrolled to `visible`. */
function tiledPage(scale: number) {
  return {
    doc: letterDoc,
    sourceIndex: 0,
    rotation: 0 as const,
    scale,
    widthPt: 612,
    heightPt: 792,
    paperColor: null,
    runtime: runtime as never,
  };
}

describe("PageCanvas lifecycle", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
    cancelRender.mockClear();
    rasteredScales.length = 0;
    rasteredWidths.length = 0;
    tileRequests.length = 0;
    restoreMatchMedia();
    restoreMatchMedia = () => {};
    visible = null;
    setDpr(1);
  });

  afterAll(() => {
    mock.restore();
  });

  test("releases both double-buffer backing stores on unmount", async () => {
    const view = render(
      <PageCanvas
        doc={{} as PDFDocumentProxy}
        sourceIndex={0}
        rotation={0}
        scale={1}
        widthPt={612}
        heightPt={792}
        paperColor={null}
        runtime={runtime as never}
      />,
    );
    const canvases = Array.from(
      view.container.querySelectorAll<HTMLCanvasElement>("canvas"),
    );
    expect(canvases).toHaveLength(2);
    await waitFor(() => {
      expect(canvases.some((canvas) => canvas.width > 0)).toBe(true);
    });

    view.unmount();

    expect(canvases.map((canvas) => [canvas.width, canvas.height])).toEqual([
      [0, 0],
      [0, 0],
    ]);
  });

  test("a lone scale change rasters at once; only a stream waits the settle", async () => {
    const props = {
      doc: {} as PDFDocumentProxy,
      sourceIndex: 0,
      rotation: 0 as const,
      widthPt: 612,
      heightPt: 792,
      paperColor: null,
      runtime: runtime as never,
    };
    const view = render(<PageCanvas {...props} scale={1} />);
    await waitFor(() => expect(rasteredScales).toEqual([1]));
    await pause(200);

    // A pinch release, a toolbar step: one change, sharp right away instead
    // of 160 ms of stretched bitmap first.
    view.rerender(<PageCanvas {...props} scale={1.5} />);
    await pause(40);
    expect(rasteredScales).toEqual([1, 1.5]);

    // A window resize re-fits the page every frame: changes closer together
    // than the settle coalesce into one raster of the last scale.
    await pause(200);
    view.rerender(<PageCanvas {...props} scale={1.6} />);
    await pause(20);
    view.rerender(<PageCanvas {...props} scale={1.7} />);
    await pause(60);
    expect(rasteredScales).toEqual([1, 1.5, 1.6]);
    await pause(200);
    expect(rasteredScales).toEqual([1, 1.5, 1.6, 1.7]);
  });

  test("re-rasters at the new pixel ratio when the window changes screens", async () => {
    const moveToScreen = watchResolutionQueries();
    render(<PageCanvas {...tiledPage(1)} />);
    await waitFor(() => expect(rasteredWidths).toEqual([612]));

    // Same zoom, same CSS size: only the screen got sharper.
    moveToScreen(2);
    await waitFor(() => expect(rasteredWidths).toEqual([612, 1224]));
  });

  // Stage 1.4 of docs/PLAN-RUST-PDF-CORE-2026-09.md: only what is on screen,
  // plus one tile around it, is ever drawn at a scale past the budget.
  describe("viewport tiles", () => {
    const TILE = 512;
    // 948 × 838 CSS px at dpr 2, at the top-left of the page.
    const screen = { x: 0, y: 0, width: 1896, height: 1676 };

    test("a page inside the backdrop budget draws no tiles", async () => {
      setDpr(2);
      visible = screen;
      render(<PageCanvas {...tiledPage(2)} />);
      await waitFor(() => expect(rasteredScales).toEqual([2]));
      await pause(20);
      // Lengths, not the requests: a failure diff of canvases never finishes.
      expect(tileRequests.length).toBe(0);
    });

    test("tiles cover the screen plus one tile around it, at the full scale", async () => {
      setDpr(2);
      visible = screen;
      render(<PageCanvas {...tiledPage(8)} />);
      await waitFor(() => expect(tileRequests.length).toBeGreaterThan(0));
      // Columns and rows 0–3 are on screen; the ring adds column and row 4.
      expect(tileRequests).toHaveLength(25);
      for (const tile of tileRequests) {
        expect(tile.scale).toBe(8);
        expect(tile.x).toBeLessThanOrEqual(4 * TILE);
        expect(tile.y).toBeLessThanOrEqual(4 * TILE);
      }
    });

    test("scrolling drops the tiles that leave the ring and keeps the rest", async () => {
      setDpr(2);
      visible = screen;
      render(<PageCanvas {...tiledPage(8)} />);
      await waitFor(() => expect(tileRequests).toHaveLength(25));
      const first = [...tileRequests];
      act(() => {
        for (const tile of first.filter((t) => t.y === 0)) tile.finish();
      });
      await pause(0);

      // Scroll down by four tiles: rows 0–2 fall out of the ring.
      visible = { ...screen, y: 4 * TILE };
      act(() => {
        window.dispatchEvent(new Event("scroll"));
      });
      await waitFor(() => expect(tileRequests.length).toBeGreaterThan(25));

      for (const tile of first) {
        const kept = tile.y >= 3 * TILE;
        if (kept) {
          expect(tile.cancelled).toBe(false);
        } else if (tile.y === 0) {
          // Drawn, then scrolled away: its bitmap is freed.
          expect([tile.canvas.width, tile.canvas.height]).toEqual([0, 0]);
        } else {
          expect(tile.cancelled).toBe(true);
        }
      }
      const added = tileRequests.slice(25);
      expect(added.every((tile) => tile.y >= 5 * TILE)).toBe(true);
    });

    // A region the engine rejects would fail the same way again: asking for
    // it on every scroll frame only floods the render queue.
    test("a tile that failed to draw is not asked for again while scrolling", async () => {
      setDpr(2);
      visible = screen;
      const warn = mock(() => undefined);
      const originalWarn = console.warn;
      console.warn = warn;
      try {
        render(<PageCanvas {...tiledPage(8)} />);
        await waitFor(() => expect(tileRequests).toHaveLength(25));
        act(() => {
          for (const tile of tileRequests) tile.fail();
        });
        await pause(0);

        for (let frame = 0; frame < 3; frame += 1) {
          act(() => {
            window.dispatchEvent(new Event("scroll"));
          });
          await pause(32);
        }
        expect(tileRequests.length).toBe(25);
        expect(warn).toHaveBeenCalledTimes(25);
      } finally {
        console.warn = originalWarn;
      }
    });

    test("a scale change cancels every tile still drawing", async () => {
      setDpr(2);
      visible = screen;
      const view = render(<PageCanvas {...tiledPage(8)} />);
      await waitFor(() => expect(tileRequests).toHaveLength(25));
      const atEight = [...tileRequests];

      view.rerender(<PageCanvas {...tiledPage(7)} />);
      await waitFor(() =>
        expect(tileRequests.some((tile) => tile.scale === 7)).toBe(true),
      );
      expect(atEight.every((tile) => tile.cancelled)).toBe(true);
    });

    test("a sharper screen at the same zoom brings tiles in", async () => {
      const moveToScreen = watchResolutionQueries();
      visible = screen;
      // Letter at 3x: 4.4 MP at dpr 1, inside the budget; 17 MP at dpr 2.
      render(<PageCanvas {...tiledPage(3)} />);
      await waitFor(() => expect(rasteredScales).toEqual([3]));
      await pause(20);
      expect(tileRequests.length).toBe(0);

      moveToScreen(2);
      await waitFor(() => expect(tileRequests).toHaveLength(25));
    });

    test("unmounting frees every tile bitmap", async () => {
      setDpr(2);
      visible = screen;
      const view = render(<PageCanvas {...tiledPage(8)} />);
      await waitFor(() => expect(tileRequests).toHaveLength(25));
      act(() => {
        for (const tile of tileRequests) tile.finish();
      });
      await pause(0);
      expect(tileRequests.every((tile) => tile.canvas.width > 0)).toBe(true);

      view.unmount();

      expect(
        tileRequests.map((tile) => [tile.canvas.width, tile.canvas.height]),
      ).toEqual(tileRequests.map(() => [0, 0]));
    });
  });
});
