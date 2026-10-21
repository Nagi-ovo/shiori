import "../../test/setupDom";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import i18n from "../../i18n";
import type {
  HighlightOverlay,
  NoteOverlay,
  Overlay,
  PageModel,
  RectOverlay,
} from "../../pdf/model/types";
import { useAppStore, useEditorStore } from "../store/store";
import { ContextualToolbar } from "./ContextualToolbar";

// Recolouring the selected annotation from the "+" popover. The native colour
// well streams an input event per drag tick; each one used to land on the
// undo stack, so a two-second drag pushed every real edit out of the
// 100-entry history and Undo stepped through dozens of near-identical
// colours. One popover session is one edit.

const page: PageModel = {
  id: "page-1",
  sourceIndex: -1,
  rotation: 0,
  widthPt: 612,
  heightPt: 792,
  blank: true,
};

const highlight: HighlightOverlay = {
  type: "highlight",
  id: "hl-1",
  pageId: page.id,
  rects: [{ x: 10, y: 20, w: 30, h: 8 }],
  color: "#f4d674",
  opacity: 0.35,
};

const rect: RectOverlay = {
  type: "rect",
  id: "rect-1",
  pageId: page.id,
  rect: { x: 40, y: 40, w: 100, h: 60 },
  color: "#b13a2e",
  strokeWidth: 2,
  fill: null,
};

const note: NoteOverlay = {
  type: "note",
  id: "note-1",
  pageId: page.id,
  rect: { x: 200, y: 200, w: 24, h: 24 },
  text: "",
  color: "#f7e9a8",
};

let restoreResizeObserver: () => void = () => undefined;

function installResizeObserver(): () => void {
  const previous = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  return () => {
    if (previous === undefined) {
      delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    } else {
      globalThis.ResizeObserver = previous;
    }
  };
}

function select(overlay: Overlay): void {
  act(() => {
    useEditorStore.setState({
      model: { pages: [page], overlays: [overlay] },
      undoStack: [],
      redoStack: [],
      selectedIds: [overlay.id],
      tool: "select",
    } as never);
  });
}

function current<T extends Overlay>(id: string): T {
  const found = useEditorStore
    .getState()
    .model.overlays.find((o) => o.id === id);
  if (!found) throw new Error(`overlay ${id} is gone`);
  return found as T;
}

const undoDepth = () => useEditorStore.getState().undoStack.length;

/** The n-th "+" button in the inspector (rect has stroke, then fill). */
function openPopover(container: HTMLElement, index = 0): void {
  const more = Array.from(
    container.querySelectorAll<HTMLButtonElement>("button"),
  ).filter((b) => b.title === i18n.t("color.more"));
  const button = more[index];
  if (!button) throw new Error(`no colour popover trigger #${index}`);
  act(() => {
    fireEvent.click(button);
  });
}

function colourWell(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="color"]');
  if (!input) throw new Error("the popover's colour well is not open");
  return input;
}

/**
 * One drag through the native picker: an input event per tick. happy-dom has
 * no `oninput` on document, so React falls back to its legacy change
 * detection, which reads the value of the focused input on key events; the
 * keyUp is what makes React see each tick, as a browser's input event would.
 */
function dragThrough(colours: string[]): void {
  const input = colourWell();
  act(() => {
    input.focus();
  });
  for (const c of colours) {
    act(() => {
      fireEvent.input(input, { target: { value: c } });
      fireEvent.keyUp(input);
    });
  }
}

function closeWithEscape(): void {
  act(() => {
    fireEvent.keyDown(document, { key: "Escape" });
  });
}

function dragTicks(count: number): string[] {
  return Array.from({ length: count }, (_, i) => {
    const v = (0x10 + i).toString(16).padStart(2, "0");
    return `#${v}${v}${v}`;
  });
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  restoreResizeObserver = installResizeObserver();
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  restoreResizeObserver();
  act(() => {
    useEditorStore.setState({
      model: { pages: [], overlays: [] },
      undoStack: [],
      redoStack: [],
      selectedIds: [],
      tool: "select",
    } as never);
  });
});

describe("recolouring the selection through the colour popover", () => {
  test("a drag through the native picker is one undo step", () => {
    select(highlight);
    const view = render(<ContextualToolbar />);
    openPopover(view.container);
    const ticks = dragTicks(40);
    dragThrough(ticks);

    // The document follows the drag live...
    expect(current<HighlightOverlay>(highlight.id).color).toBe(ticks.at(-1)!);
    // ...but history holds one step for the whole gesture.
    expect(undoDepth()).toBe(1);

    closeWithEscape();
    act(() => useEditorStore.getState().undo());
    expect(current<HighlightOverlay>(highlight.id).color).toBe(highlight.color);
  });

  test("a palette pick after dragging ends the same step", () => {
    select(highlight);
    const view = render(<ContextualToolbar />);
    openPopover(view.container);
    dragThrough(dragTicks(5));
    const pick = document.querySelector<HTMLButtonElement>(
      `button[aria-label="${i18n.t("color.swatch", { hex: "#2f5a8a" })}"]`,
    );
    act(() => {
      fireEvent.click(pick!);
    });

    expect(current<HighlightOverlay>(highlight.id).color).toBe("#2f5a8a");
    expect(undoDepth()).toBe(1);
    act(() => useEditorStore.getState().undo());
    expect(current<HighlightOverlay>(highlight.id).color).toBe(highlight.color);
  });

  test("two popover sessions stay two undo steps", () => {
    select(highlight);
    const view = render(<ContextualToolbar />);
    openPopover(view.container);
    dragThrough(["#111111", "#222222"]);
    closeWithEscape();
    openPopover(view.container);
    dragThrough(["#333333", "#444444"]);
    closeWithEscape();

    expect(undoDepth()).toBe(2);
    act(() => useEditorStore.getState().undo());
    expect(current<HighlightOverlay>(highlight.id).color).toBe("#222222");
  });

  test("dragging on after an Undo mid-drag opens a fresh step", () => {
    select(highlight);
    const view = render(<ContextualToolbar />);
    openPopover(view.container);
    dragThrough(["#111111", "#222222"]);
    act(() => useEditorStore.getState().undo());
    expect(current<HighlightOverlay>(highlight.id).color).toBe(highlight.color);

    dragThrough(["#333333"]);
    // Without a new step this change would sit on top of history where
    // Undo could not reach it.
    expect(undoDepth()).toBe(1);
    act(() => useEditorStore.getState().undo());
    expect(current<HighlightOverlay>(highlight.id).color).toBe(highlight.color);
  });

  test("the rectangle's fill picker coalesces its drag too", () => {
    select(rect);
    const view = render(<ContextualToolbar />);
    openPopover(view.container, 1);
    dragThrough(dragTicks(12));

    expect(current<RectOverlay>(rect.id).fill).toBe(dragTicks(12).at(-1)!);
    expect(current<RectOverlay>(rect.id).color).toBe(rect.color);
    expect(undoDepth()).toBe(1);
  });

  test("a note's drag still carries its colour into the next note", () => {
    select(note);
    const view = render(<ContextualToolbar />);
    openPopover(view.container);
    dragThrough(["#123456", "#234567"]);

    expect(current<NoteOverlay>(note.id).color).toBe("#234567");
    expect(useAppStore.getState().annotDefaults.noteColor).toBe("#234567");
    expect(undoDepth()).toBe(1);
  });

  test("each main-row swatch click stays its own step", () => {
    select(highlight);
    const view = render(<ContextualToolbar />);
    const swatch = (hex: string) =>
      view.container.querySelector<HTMLButtonElement>(
        `button[aria-label="${i18n.t("color.swatch", { hex })}"]`,
      )!;
    act(() => {
      fireEvent.click(swatch("#e8a37a"));
    });
    act(() => {
      fireEvent.click(swatch("#aac296"));
    });
    expect(undoDepth()).toBe(2);
  });
});
