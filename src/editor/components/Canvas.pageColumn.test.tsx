import "../../test/setupDom";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import i18n from "../../i18n";
import type { PageModel } from "../../pdf/model/types";
import { fakePdfDocument, withFakePdfEngine } from "../../test/fakePdfEngine";
import { createPdfEditorStore, EditorStoreContext } from "../store/store";

function defineTestGlobal(name: string, value: unknown): void {
  if (Object.prototype.hasOwnProperty.call(globalThis, name)) return;
  Object.defineProperty(globalThis, name, { configurable: true, value });
}
defineTestGlobal("__APP_VERSION__", "test");
defineTestGlobal("__BUILD_EXPIRY_DAYS__", 0);
defineTestGlobal("__BUILD_TIMESTAMP__", 0);
defineTestGlobal("__SHIORI_ANDROID_DISTRIBUTION__", undefined);
defineTestGlobal("__TAURI_ENV_FAMILY__", undefined);
defineTestGlobal("__TAURI_ENV_PLATFORM__", undefined);
defineTestGlobal("__TAURI_ENV_TARGET_TRIPLE__", undefined);
// Six source pages; the page layers' reads never finish, as these tests are
// about the column, not what is drawn in it.
withFakePdfEngine({
  pageCount: () => 6,
  renderRegion: () => ({ cancel: () => undefined, done: new Promise<void>(() => undefined) }),
  pageText: () => new Promise(() => undefined),
  pageLinks: async () => [],
});
// happy-dom has no ResizeObserver; the column only uses it for the fit
// width, which these tests do not exercise. Installed for this file only:
// other suites install their own and expect the global to be absent after.
let previousResizeObserver: unknown;
function installResizeObserver() {
  previousResizeObserver = (globalThis as { ResizeObserver?: unknown })
    .ResizeObserver;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
function restoreResizeObserver() {
  if (previousResizeObserver === undefined) {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  } else {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
      previousResizeObserver;
  }
}

const {
  Canvas,
  armPdfZoomPreviewLayer,
  restorePdfZoomPreviewLayer,
} = await import("./Canvas");

// Blank pages render without the engine, so the column's own behaviour — which
// nodes exist, where the scroller lands — is observable in happy-dom.
function blankPages(count: number): PageModel[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `page-${index}`,
    sourceIndex: -1,
    blank: true,
    rotation: 0 as const,
    widthPt: 612,
    heightPt: 792,
  }));
}

function mountColumn(activeIndex: number, pageCount = 6) {
  const store = createPdfEditorStore();
  const pages = blankPages(pageCount);
  store.setState({
    model: { pages, overlays: [] },
    activePageId: pages[activeIndex]!.id,
    scale: 1,
    fitMode: "none",
  });
  const view = render(
    <EditorStoreContext.Provider value={store}>
      <Canvas doc={fakePdfDocument()} />
    </EditorStoreContext.Provider>,
  );
  const scroller = view.container.querySelector<HTMLElement>(
    "[data-shiori-pdf-scroller]",
  )!;
  const pageNodes = () =>
    Array.from(
      view.container.querySelectorAll<HTMLElement>("[data-shiori-page-id]"),
    );
  return { store, view, scroller, pageNodes };
}

/** Records programmatic scrolls instead of performing them. */
function recordScrollTo(scroller: HTMLElement): ScrollToOptions[] {
  const calls: ScrollToOptions[] = [];
  scroller.scrollTo = ((options: ScrollToOptions) => {
    calls.push(options);
  }) as typeof scroller.scrollTo;
  return calls;
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("PDF page column", () => {
  beforeAll(async () => {
    installResizeObserver();
    await i18n.changeLanguage("en");
  });

  afterAll(() => {
    restoreResizeObserver();
  });

  test("opens on the active page", () => {
    const { scroller, pageNodes } = mountColumn(3);
    // Page 3 at scale 1, Comfortable margins: three 847px slots above it.
    expect(scroller.scrollTop).toBe(3 * 847);
    expect(pageNodes().map((node) => node.dataset.shioriPageId)).toContain(
      "page-3",
    );
  });

  // The defect: a zoom commit re-keyed the virtual list, so every page node
  // was destroyed and recreated over the following frames — an empty column,
  // pages popping in, highlights vanishing and reappearing: the flash on
  // every pinch release. The same elements must survive a scale change.
  test("keeps the same page elements across a scale change", () => {
    const { store, scroller, pageNodes } = mountColumn(1);
    const before = pageNodes();
    expect(before.length).toBeGreaterThan(0);
    act(() => store.getState().setScale(2));
    const after = pageNodes();
    const byId = (nodes: HTMLElement[]) =>
      new Map(nodes.map((node) => [node.dataset.shioriPageId, node]));
    const afterById = byId(after);
    // The active page is in both ranges and is the same element; every page
    // still in range is the element it was.
    expect(afterById.get("page-1")).toBe(byId(before).get("page-1")!);
    for (const node of before) {
      const successor = afterById.get(node.dataset.shioriPageId);
      if (successor) expect(successor).toBe(node);
    }
    // The new layout landed before paint: page 1's slot at scale 2 starts
    // after one 1_639px slot, and the (zero-height) viewport centre stays
    // on page 1's top edge.
    expect(scroller.scrollTop).toBe(1_639);
  });

  // Pressing on a page makes it the active page (the paste and keyboard
  // target) but is not a request to go there: scrolling the page to the top
  // dragged what the reader was pressing on out from under the pointer.
  test("pressing on a page that peeks into view does not scroll it to the top", async () => {
    const { store, view, scroller } = mountColumn(0);
    const scrolls = recordScrollTo(scroller);
    const top = scroller.scrollTop;
    const overlay = view.container.querySelector<HTMLElement>(
      '[data-shiori-page-id="page-1"] .shioriOverlayLayer',
    );
    expect(overlay).not.toBeNull();
    // The press hit-tests for a link under the pointer; the test DOM has no
    // elementsFromPoint and no layout, so nothing is under it.
    const hadElementsFromPoint = "elementsFromPoint" in document;
    if (!hadElementsFromPoint) {
      Object.defineProperty(document, "elementsFromPoint", {
        configurable: true,
        value: () => [],
      });
    }
    try {
      await act(async () => {
        fireEvent.pointerDown(overlay!, {
          button: 0,
          pointerType: "mouse",
          clientX: 200,
          clientY: 40,
        });
      });
    } finally {
      if (!hadElementsFromPoint) {
        delete (document as { elementsFromPoint?: unknown }).elementsFromPoint;
      }
    }
    expect(store.getState().activePageId).toBe("page-1");
    expect(scrolls).toEqual([]);
    expect(scroller.scrollTop).toBe(top);
  });

  test("J and K go to the next and the previous page", async () => {
    const { store, scroller } = mountColumn(2);
    const scrolls = recordScrollTo(scroller);
    await act(async () => {
      fireEvent.keyDown(window, { key: "j" });
    });
    expect(store.getState().activePageId).toBe("page-3");
    expect(scrolls.at(-1)?.top).toBe(3 * 847);
    await act(async () => {
      fireEvent.keyDown(window, { key: "k" });
    });
    expect(store.getState().activePageId).toBe("page-2");
    expect(scrolls.at(-1)?.top).toBe(2 * 847);
  });

  // A dialog (the shortcut sheet, a confirm, go-to-page with its panel
  // focused) sits over the canvas, but its keys bubble to the canvas's
  // window listener: a letter switched the tool behind it, J moved the page,
  // Delete removed the selected annotation.
  test("keys pressed in an open dialog leave the canvas alone", async () => {
    const { store } = mountColumn(2);
    await act(async () => {
      store.getState().addOverlay({
        type: "rect",
        id: "note-1",
        pageId: "page-2",
        rect: { x: 10, y: 10, w: 40, h: 20 },
        color: "#b13a2e",
        strokeWidth: 1,
        fill: null,
      });
      store.getState().selectOnly("note-1");
    });
    const backdrop = document.createElement("div");
    backdrop.setAttribute("aria-modal", "true");
    const button = document.createElement("button");
    backdrop.append(button);
    document.body.append(backdrop);
    for (const key of ["Delete", "h", "j"]) {
      await act(async () => {
        fireEvent.keyDown(button, { key });
      });
    }
    const { tool, activePageId, model } = store.getState();
    expect({ tool, activePageId, overlays: model.overlays.map((o) => o.id) }).toEqual({
      tool: "select",
      activePageId: "page-2",
      overlays: ["note-1"],
    });
  });

  // The keyboard stepped by a fixed 0.1 while the toolbar walked the
  // ladder: 125% went to 135%, and 100% could not be reached from a fit.
  test("Cmd+= and Cmd+- walk the toolbar's zoom ladder", async () => {
    const { store } = mountColumn(0);
    await act(async () => {
      store.getState().setScale(1.497);
    });
    const press = async (key: string) => {
      await act(async () => {
        fireEvent.keyDown(window, { key, metaKey: true });
      });
      return store.getState().scale;
    };
    expect(await press("-")).toBe(1.25);
    expect(await press("-")).toBe(1.1);
    expect(await press("-")).toBe(1);
    expect(await press("=")).toBe(1.1);
    expect(await press("+")).toBe(1.25);
  });

  // A long scroll moves the viewport onto pages that are not mounted yet.
  // The browser runs the scroll's measuring frame before React commits the
  // range that mounts them, so that frame finds nothing (or a sliver of an
  // overscan page) in view; with no further scroll event the active page
  // stayed on the page left behind.
  test("the active page follows a long scroll once its pages mount", async () => {
    // happy-dom lays nothing out: each page gets the box its 847px slot
    // puts it in, relative to the scroller's top edge.
    const rect = (top: number, height: number) =>
      ({ x: 0, y: top, left: 0, top, width: 612, height, right: 612, bottom: top + height }) as DOMRect;
    const boundingRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const scroller = document.querySelector<HTMLElement>("[data-shiori-pdf-scroller]");
      if (this === scroller) return rect(0, 900);
      const id = this.dataset.shioriPageId;
      if (!id || !scroller) return boundingRect.call(this);
      return rect(Number(id.slice("page-".length)) * 847 + 40 - scroller.scrollTop, 792);
    };
    // The browser's ordering, made deterministic: a scroll's measuring
    // frame runs before React commits the range that scroll asked for.
    const requestFrame = window.requestAnimationFrame;
    window.requestAnimationFrame = (callback) => {
      callback(performance.now());
      return 0;
    };
    try {
      const { store, scroller, pageNodes } = mountColumn(20, 24);
      Object.defineProperty(scroller, "clientHeight", {
        configurable: true,
        value: 900,
      });
      expect(pageNodes().map((node) => node.dataset.shioriPageId)).not.toContain(
        "page-0",
      );
      await act(async () => {
        scroller.scrollTop = 0;
        fireEvent.scroll(scroller);
      });
      expect(store.getState().activePageId).toBe("page-0");
    } finally {
      window.requestAnimationFrame = requestFrame;
      HTMLElement.prototype.getBoundingClientRect = boundingRect;
    }
  });

  test("keeps the live-zoom preview layer in normal flow", () => {
    const layer = document.createElement("div");
    const snapshot = armPdfZoomPreviewLayer(layer);
    // The preview is compositor-only. A position:fixed layer resolves against
    // the viewport and escapes the scroller's overflow clip, so zoomed pages
    // painted over the sidebar and the surrounding chrome.
    expect(layer.style.position).toBe("");
    expect(layer.style.transformOrigin).toBe("0 0");
    expect(layer.style.pointerEvents).toBe("none");
    expect(layer.style.willChange).toBe("transform");
    // A stylesheet transition on transform would tween every preview frame
    // and animate the restore — the commit then measures mid-tween rects.
    expect(layer.style.transition).toBe("none");

    layer.style.transform = "translate3d(4px, 6px, 0) scale(1.3)";
    restorePdfZoomPreviewLayer(snapshot);
    expect(layer.style.transform).toBe("");
    expect(layer.style.transformOrigin).toBe("");
    expect(layer.style.pointerEvents).toBe("");
    expect(layer.style.willChange).toBe("");
    expect(layer.style.transition).toBe("");
  });

  test("a double tap zooms in at the tap through the preview and commit path", async () => {
    const { store, scroller, pageNodes } = mountColumn(0);
    const target = pageNodes()[0]!;
    const tap = (at: number) => {
      const finger = new window.Touch({
        identifier: 1,
        target,
        clientX: 200,
        clientY: 400,
      });
      const start = new window.TouchEvent("touchstart", {
        bubbles: true,
        touches: [finger],
        changedTouches: [finger],
      });
      const end = new window.TouchEvent("touchend", {
        bubbles: true,
        touches: [],
        changedTouches: [finger],
      });
      Object.defineProperty(start, "timeStamp", { value: at });
      Object.defineProperty(end, "timeStamp", { value: at + 40 });
      target.dispatchEvent(start);
      target.dispatchEvent(end);
    };

    tap(1_000);
    expect(store.getState().scale).toBe(1);
    // Two taps 800 ms apart are two single taps.
    tap(1_800);
    expect(store.getState().scale).toBe(1);

    await act(async () => {
      tap(2_000);
      // The zoom animates over a few frames before it commits.
      await new Promise((resolve) => window.setTimeout(resolve, 400));
    });
    expect(store.getState().scale).toBe(2);
    expect(scroller.classList.contains("is-gesture-zooming")).toBe(false);
  });

  // A trackpad pinch is a gesturestart … gesturechange … gestureend bracket.
  // Should the end never arrive (focus leaves the window mid-pinch, the
  // webview drops it), the preview must still land as a zoom instead of
  // sitting transformed until the next gesture.
  test("a trackpad pinch whose gesture end never arrives still commits", async () => {
    // The canvas tells its own events apart with `instanceof Node`, a global
    // every browser has and the test DOM does not install.
    const hadNode = "Node" in globalThis;
    if (!hadNode) Object.defineProperty(globalThis, "Node", { configurable: true, value: window.Node });
    try {
      await trackpadPinchWithoutEnd();
    } finally {
      if (!hadNode) delete (globalThis as { Node?: unknown }).Node;
    }
  });

  async function trackpadPinchWithoutEnd() {
    const { store, view, pageNodes } = mountColumn(0);
    const target = pageNodes()[0]!;
    const zooming = () => view.container.querySelector(".is-gesture-zooming") !== null;
    const gesture = (type: string, scale?: number) => {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        clientX: { value: 200 },
        clientY: { value: 300 },
        ...(scale === undefined ? {} : { scale: { value: scale } }),
      });
      target.dispatchEvent(event);
    };

    await act(async () => {
      gesture("gesturestart");
      gesture("gesturechange", 1.5);
    });
    expect(store.getState().scale).toBe(1);
    expect(zooming()).toBe(true);

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 1_200));
    });
    expect(store.getState().scale).toBe(1.5);
    expect(zooming()).toBe(false);
  }

  test("a pinch whose end never arrives still lets scrolling mount pages", async () => {
    const { scroller, pageNodes } = mountColumn(0);
    const target = pageNodes()[0]!;
    const touch = (id: number, x: number, y: number) =>
      new window.Touch({ identifier: id, target, clientX: x, clientY: y });
    const fire = (type: string, points: Array<[number, number, number]>) => {
      target.dispatchEvent(
        new window.TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches: points.map(([id, x, y]) => touch(id, x, y)),
        }),
      );
    };

    // Two fingers land and spread: the zoom preview opens and the canvas
    // marks itself as gesture-zooming.
    fire("touchstart", [[1, 150, 400]]);
    fire("touchstart", [
      [1, 150, 400],
      [2, 250, 400],
    ]);
    await act(async () => {
      fire("touchmove", [
        [1, 120, 400],
        [2, 280, 400],
      ]);
    });

    // No touchend. On Android it is delivered to the node touchstart hit,
    // and this list unmounts page nodes as the range moves — so the end of
    // the gesture can be lost. 26.9.8 gated the scroll handler's re-range on
    // the gesture flag, so a lost end left the mounted window frozen and the
    // reader scrolled into blank paper.
    await act(async () => {
      scroller.scrollTop = 5 * 847;
      fireEvent.scroll(scroller);
    });

    expect(pageNodes().map((node) => node.dataset.shioriPageId)).toContain(
      "page-5",
    );
  });
});
