import type { ToolId } from "../../pdf/model/types";
import { isFindHotkey, isPrintHotkey, isShortcutsHotkey } from "../shortcuts/hotkeys";

/**
 * The PDF canvas's keyboard bindings: a key event in, the command it names
 * out. Pure, so the whole map is testable without a canvas; Canvas runs the
 * command and decides from the document's state whether it applied (and so
 * whether to prevent the key's default).
 */

/** The parts of a KeyboardEvent the bindings read. */
export type CanvasKeyEvent = {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  target: { tagName: string; isContentEditable: boolean } | null;
};

export type CanvasCommand =
  | { type: "spacePan"; repeat: boolean }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "copy" }
  | { type: "paste" }
  | { type: "duplicate" }
  | { type: "selectAllOnPage" }
  | { type: "goToPageDialog" }
  | { type: "print" }
  | { type: "find" }
  | { type: "zoom"; direction: "in" | "out" }
  | { type: "fitWidth" }
  | { type: "actualSize" }
  /** Points in PDF user space per press; `repeat` is the key's auto-repeat. */
  | { type: "nudge"; dx: number; dy: number; repeat: boolean }
  | { type: "delete" }
  | { type: "placeArmedTool" }
  | { type: "shortcuts" }
  | { type: "escape" }
  | { type: "tool"; tool: ToolId }
  | { type: "page"; delta: -1 | 1 };

const TOOL_KEYS: Record<string, ToolId> = {
  v: "select",
  h: "highlight",
  u: "underline",
  i: "ink",
  g: "signature",
  s: "stamp",
  r: "rect",
  c: "callout",
  t: "text",
};

export function arrowDelta(key: string): { x: number; y: number } | null {
  switch (key) {
    case "ArrowLeft":
      return { x: -1, y: 0 };
    case "ArrowRight":
      return { x: 1, y: 0 };
    case "ArrowUp":
      return { x: 0, y: -1 };
    case "ArrowDown":
      return { x: 0, y: 1 };
    default:
      return null;
  }
}

export function resolveCanvasKey(e: CanvasKeyEvent): CanvasCommand | null {
  const target = e.target;
  if (
    target &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
  ) {
    return null;
  }
  if (e.code === "Space") return { type: "spacePan", repeat: e.repeat };

  const mod = e.metaKey || e.ctrlKey;
  const letter = e.key.toLowerCase();
  if (mod) {
    if (letter === "z") return { type: e.shiftKey ? "redo" : "undo" };
    if (letter === "y") return { type: "redo" };
    if (letter === "c") return { type: "copy" };
    if (letter === "v") return { type: "paste" };
    if (letter === "d") return { type: "duplicate" };
    if (letter === "a") return { type: "selectAllOnPage" };
    if (letter === "g") return { type: "goToPageDialog" };
    if (isPrintHotkey(e)) return { type: "print" };
    if (isFindHotkey(e)) return { type: "find" };
    if (e.key === "=" || e.key === "+") return { type: "zoom", direction: "in" };
    if (e.key === "-" || e.key === "_") return { type: "zoom", direction: "out" };
    if (e.key === "0") return { type: "fitWidth" };
    if (e.key === "1") return { type: "actualSize" };
  }

  const arrow = mod ? null : arrowDelta(e.key);
  if (arrow) {
    const step = e.shiftKey ? 10 : 1;
    return { type: "nudge", dx: arrow.x * step, dy: arrow.y * step, repeat: e.repeat };
  }
  if (e.key === "Delete" || e.key === "Backspace") return { type: "delete" };
  if (e.key === "Enter" && !mod && !e.shiftKey) return { type: "placeArmedTool" };
  if (isShortcutsHotkey(e)) return { type: "shortcuts" };
  if (mod) return null;
  if (e.key === "Escape") return { type: "escape" };
  if (e.shiftKey && letter === "u") return { type: "tool", tool: "strikethrough" };
  if (letter === "j") return { type: "page", delta: 1 };
  if (letter === "k") return { type: "page", delta: -1 };
  const tool = TOOL_KEYS[letter];
  return tool ? { type: "tool", tool } : null;
}
