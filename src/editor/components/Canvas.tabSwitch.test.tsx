import "../../test/setupDom";
import { act, cleanup, render } from "@testing-library/react";
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
import {
  createPdfEditorStore,
  EditorStoreContext,
  type PdfEditorStoreApi,
} from "../store/store";

// One canvas serves every PDF tab: switching tabs (or opening a second PDF
// while one is showing) hands the same mounted canvas another tab's store.
// 26.10.20 and 26.10.23 kept zooming and fitting the first tab's store, so
// the visible tab never fitted and every pinch snapped back to 100%.

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
withFakePdfEngine({
  pageCount: () => 3,
  renderRegion: () => ({ cancel: () => undefined, done: new Promise<void>(() => undefined) }),
  pageText: () => new Promise(() => undefined),
  pageLinks: async () => [],
});

// happy-dom has no ResizeObserver, so the column keeps its initial 800px
// width; installed for this file only, as other suites expect it absent.
let previousResizeObserver: unknown;
const hadNode = "Node" in globalThis;

const { Canvas } = await import("./Canvas");

function tabStore(tab: string, fitMode: "width" | "none"): PdfEditorStoreApi {
  const pages: PageModel[] = Array.from({ length: 3 }, (_, index) => ({
    id: `${tab}-page-${index}`,
    sourceIndex: -1,
    blank: true,
    rotation: 0 as const,
    widthPt: 612,
    heightPt: 792,
  }));
  const store = createPdfEditorStore();
  store.setState({
    model: { pages, overlays: [] },
    activePageId: pages[0]!.id,
    scale: 1,
    fitMode,
  });
  return store;
}

/**
 * Mounts the canvas on tab A and lets its effects run, then switches the
 * same canvas to tab B. Two separate acts: in one, A's effects would only
 * run after the switch and the canvas would never have seen A.
 */
async function switchTabs(a: PdfEditorStoreApi, b: PdfEditorStoreApi) {
  const doc = fakePdfDocument();
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <EditorStoreContext.Provider value={a}>
        <Canvas doc={doc} />
      </EditorStoreContext.Provider>,
    );
  });
  await act(async () => {
    view.rerender(
      <EditorStoreContext.Provider value={b}>
        <Canvas doc={doc} />
      </EditorStoreContext.Provider>,
    );
  });
  return view;
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("PDF canvas after a tab switch", () => {
  beforeAll(async () => {
    previousResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    // The canvas tells its own gesture events apart with `instanceof Node`.
    if (!hadNode) Object.defineProperty(globalThis, "Node", { configurable: true, value: window.Node });
    await i18n.changeLanguage("en");
  });

  afterAll(() => {
    if (previousResizeObserver === undefined) {
      delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    } else {
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = previousResizeObserver;
    }
    if (!hadNode) delete (globalThis as { Node?: unknown }).Node;
  });

  test("fits the tab it switched to", async () => {
    const a = tabStore("a", "none");
    const b = tabStore("b", "width");
    await switchTabs(a, b);
    // (800px column − 160px gutter) / 612pt.
    expect(b.getState().scale).toBe(1.046);
    expect(a.getState().scale).toBe(1);
  });

  test("a pinch zooms the tab it switched to and leaves the first alone", async () => {
    const a = tabStore("a", "none");
    const b = tabStore("b", "none");
    const view = await switchTabs(a, b);
    const target = view.container.querySelector<HTMLElement>(
      '[data-shiori-page-id="b-page-0"]',
    )!;
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
      gesture("gestureend", 1.5);
      await new Promise((resolve) => window.setTimeout(resolve, 400));
    });

    expect(b.getState().scale).toBe(1.5);
    expect(a.getState().scale).toBe(1);
    // The page drawn on screen follows the zoom instead of staying at 100%.
    expect(target.style.width).toBe(`${612 * 1.5}px`);
  });
});
