import "../../test/setupDom";
import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { VirtuosoMockContext } from "react-virtuoso";
import i18n from "../../i18n";
import type { Overlay, PageModel } from "../../pdf/model/types";
import {
  createPdfEditorStore,
  EditorStoreContext,
  useAppStore,
  type PdfEditorStoreApi,
} from "../store/store";
import { Thumbnails } from "./Thumbnails";
import { useCanvasKeyboard } from "./useCanvasKeyboard";

// What can go wrong between a key on the window and the canvas command:
// - a focused widget handles the key (the thumbnail rail pages on arrows, the
//   tab strip walks tabs, the navigator handle resizes) and the canvas acts
//   on it as well, nudging the selected annotation; the rail at its first
//   or last page, with no page to go to, still owns the arrow;
// - a button the reader tabbed to loses Enter and Space to the canvas, so
//   Enter places the armed tool instead of pressing the button;
// - a button a click focused takes Space away from panning;
// - Cmd+V in one tab ignores what Cmd+C copied in another;
// - an arrow held while the window loses focus never sends its keyup, so
//   the one-step-per-hold latch stays set and every later nudge lands
//   with no undo step while redo keeps the state from before it;
// - an arrow on a selection that cannot move (locked, or a contentText edit
//   pinned to its glyphs) records an undo step, clears redo and swallows
//   the key, so the page does not scroll either.

const page: PageModel = { id: "p1", sourceIndex: -1, blank: true, rotation: 0, widthPt: 612, heightPt: 792 };
const rect: Overlay = {
  type: "rect",
  id: "r1",
  pageId: "p1",
  rect: { x: 100, y: 100, w: 50, h: 50 },
  color: "#000000",
  fill: null,
  strokeWidth: 1,
};

function mount(overlays: Overlay[] = [rect]) {
  const store = createPdfEditorStore();
  store.setState({
    model: { pages: [page], overlays },
    activePageId: page.id,
    selectedIds: overlays.map((o) => o.id),
  });
  const spacePan: boolean[] = [];
  const wrapper = ({ children }: { children: ReactNode }) => (
    <EditorStoreContext.Provider value={store}>{children}</EditorStoreContext.Provider>
  );
  renderHook(
    () =>
      useCanvasKeyboard({
        editorStore: store,
        setSpacePan: (on) => spacePan.push(on),
        setPanning: () => undefined,
        panRef: { current: null },
      }),
    { wrapper },
  );
  return { store, spacePan };
}

function keydown(target: EventTarget, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function attach<T extends HTMLElement>(element: T): T {
  document.body.appendChild(element);
  return element;
}

const rectOf = (store: PdfEditorStoreApi) =>
  (store.getState().model.overlays.find((o) => o.id === rect.id) as Extract<Overlay, { rect: unknown }>).rect;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  useAppStore.setState({ overlayClipboard: [] });
});

describe("canvas keyboard", () => {
  test("a key a focused widget already handled does not also nudge the selection", () => {
    const { store } = mount();
    const rail = attach(document.createElement("div"));
    rail.tabIndex = 0;
    rail.addEventListener("keydown", (e) => e.preventDefault());

    keydown(rail, "ArrowDown");

    expect(rectOf(store)).toEqual(rect.rect);
    expect(store.getState().undoStack).toHaveLength(0);
  });

  test("arrows on the thumbnail rail at its first or last page do not nudge the selection", () => {
    const { store } = mount();
    const second: PageModel = { ...page, id: "p2" };
    store.setState({ model: { pages: [page, second], overlays: [rect] }, activePageId: second.id });
    const view = render(
      <EditorStoreContext.Provider value={store}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 600, itemHeight: 260 }}>
          <Thumbnails doc={null} onInsertPdfPages={() => undefined} embedded />
        </VirtuosoMockContext.Provider>
      </EditorStoreContext.Provider>,
    );
    const rail = view.container.querySelector<HTMLElement>(".shioriThumbsRail")!;

    for (const [activePageId, key] of [[second.id, "ArrowDown"], [page.id, "ArrowUp"]] as const) {
      act(() => store.setState({ activePageId }));
      act(() => {
        fireEvent.keyDown(rail, { key });
        fireEvent.keyUp(rail, { key });
      });

      expect(rectOf(store)).toEqual(rect.rect);
      expect(store.getState().undoStack).toHaveLength(0);
    }
  });

  test("Enter and Space on a button reached by Tab press the button, not the canvas", () => {
    const { store, spacePan } = mount([]);
    store.setState({ tool: "text" });
    const button = attach(document.createElement("button"));
    keydown(window, "Tab");
    act(() => button.focus());

    const enter = keydown(button, "Enter");
    const space = keydown(button, " ", { code: "Space" });

    expect(store.getState().model.overlays).toHaveLength(0);
    expect(enter.defaultPrevented).toBe(false);
    expect(space.defaultPrevented).toBe(false);
    expect(spacePan).toEqual([]);
  });

  test("arrows on a selection that cannot move leave history and scrolling alone", () => {
    const contentText: Overlay = {
      type: "contentText",
      id: rect.id,
      pageId: page.id,
      rect: rect.rect,
      coverRects: [rect.rect],
      originalText: "old",
      text: "new",
      fontSize: 12,
      color: "#000000",
      bold: false,
      align: "left",
      fontFamily: "sans",
    };
    for (const pinned of [{ ...rect, locked: true }, contentText]) {
      cleanup();
      const { store } = mount([pinned]);
      store.getState().addOverlay({ ...rect, id: "undone" });
      store.getState().undo();
      store.getState().setSelected([rect.id]);

      const arrow = keydown(window, "ArrowDown");

      expect(arrow.defaultPrevented).toBe(false);
      expect(rectOf(store)).toEqual(rect.rect);
      expect(store.getState().undoStack).toHaveLength(0);
      expect(store.getState().redoStack).toHaveLength(1);
    }
  });

  test("Cmd+V pastes the annotations another tab copied", () => {
    const other = createPdfEditorStore();
    other.setState({
      model: { pages: [{ ...page, id: "other-page" }], overlays: [{ ...rect, pageId: "other-page" }] },
      selectedIds: [rect.id],
    });
    other.getState().copySelected();
    const { store } = mount([]);

    const paste = keydown(window, "v", { metaKey: true });

    expect(paste.defaultPrevented).toBe(true);
    expect(store.getState().model.overlays).toMatchObject([{ type: "rect", pageId: page.id }]);
  });

  test("a nudge after the window lost focus mid-hold is its own undo step", () => {
    const { store } = mount();
    keydown(window, "ArrowDown");
    // Cmd+Tab away with the key down: the keyup goes to another app.
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    act(() => store.getState().undo());
    expect(store.getState().redoStack).toHaveLength(1);

    keydown(window, "ArrowRight");

    expect(rectOf(store)).toEqual({ ...rect.rect, x: rect.rect.x + 1 });
    expect(store.getState().redoStack).toHaveLength(0);
    act(() => store.getState().undo());
    expect(rectOf(store)).toEqual(rect.rect);
  });

  test("a button focused by a click still leaves Space to pan", () => {
    const { spacePan } = mount([]);
    const button = attach(document.createElement("button"));
    act(() => {
      button.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      button.focus();
    });

    const space = keydown(button, " ", { code: "Space" });

    expect(spacePan).toEqual([true]);
    expect(space.defaultPrevented).toBe(true);
  });
});
