import "../../test/setupDom";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import i18n from "../../i18n";
import type { Overlay, PageModel } from "../../pdf/model/types";
import { createPdfEditorStore, EditorStoreContext, type PdfEditorStoreApi } from "../store/store";
import { useCanvasKeyboard } from "./useCanvasKeyboard";

// What can go wrong between a key on the window and the canvas command:
// - a focused widget handles the key (the thumbnail rail pages on arrows, the
//   tab strip walks tabs, the navigator handle resizes) and the canvas acts
//   on it as well, nudging the selected annotation;
// - a button the reader tabbed to loses Enter and Space to the canvas, so
//   Enter places the armed tool instead of pressing the button;
// - a button a click focused takes Space away from panning;
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
