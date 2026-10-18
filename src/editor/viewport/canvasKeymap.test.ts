import { describe, expect, test } from "bun:test";
import { resolveCanvasKey, type CanvasKeyEvent } from "./canvasKeymap";

// What can go wrong turning a key into a PDF canvas command:
// - typing in a field (note text, a dialog input, a contenteditable) moves
//   pages, switches tools or deletes the selection;
// - Ctrl (Windows, Linux) is not taken as the command modifier, or Cmd is not;
// - Shift+Cmd+Z undoes instead of redoing; Caps Lock or Shift turns the
//   letter upper case and the binding misses it;
// - the shifted zoom keys (+, _) or the unshifted ones (=, -) are missed;
// - a plain letter bound to a tool fires with Cmd held (Cmd+H, Cmd+S, Cmd+T
//   belong to the system and the app), or a Cmd letter with no binding is
//   swallowed;
// - Shift+U (strikethrough) is read as U (underline);
// - arrows with Cmd held nudge (they scroll and select text instead);
// - Enter with a modifier places the armed tool;
// - a held Space restarts the pan on each auto-repeat;
// - the help sheet's variants (Cmd+?, the fullwidth ？, Cmd+/) miss.

function key(k: string, init: Partial<CanvasKeyEvent> = {}): CanvasKeyEvent {
  return {
    key: k,
    code: init.code ?? "",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    repeat: false,
    target: null,
    ...init,
  };
}
const cmd = (k: string, init: Partial<CanvasKeyEvent> = {}) => key(k, { metaKey: true, ...init });

describe("canvas keymap", () => {
  test("keys typed into a field are not commands", () => {
    for (const target of [
      { tagName: "INPUT", isContentEditable: false },
      { tagName: "TEXTAREA", isContentEditable: false },
      { tagName: "DIV", isContentEditable: true },
    ]) {
      expect(resolveCanvasKey(key("j", { target }))).toBeNull();
      expect(resolveCanvasKey(key("Backspace", { target }))).toBeNull();
      expect(resolveCanvasKey(cmd("z", { target }))).toBeNull();
      expect(resolveCanvasKey(key(" ", { code: "Space", target }))).toBeNull();
    }
    expect(resolveCanvasKey(key("j", { target: { tagName: "DIV", isContentEditable: false } }))).toEqual({
      type: "page",
      delta: 1,
    });
  });

  test("Cmd and Ctrl are both the command modifier", () => {
    expect(resolveCanvasKey(cmd("z"))).toEqual({ type: "undo" });
    expect(resolveCanvasKey(key("z", { ctrlKey: true }))).toEqual({ type: "undo" });
  });

  test("redo is Shift+Cmd+Z or Cmd+Y, in either case", () => {
    expect(resolveCanvasKey(cmd("Z", { shiftKey: true }))).toEqual({ type: "redo" });
    expect(resolveCanvasKey(cmd("z", { shiftKey: true }))).toEqual({ type: "redo" });
    expect(resolveCanvasKey(cmd("y"))).toEqual({ type: "redo" });
    expect(resolveCanvasKey(cmd("Z"))).toEqual({ type: "undo" });
  });

  test("clipboard, duplicate, select all, go to page, print and find", () => {
    expect(resolveCanvasKey(cmd("c"))).toEqual({ type: "copy" });
    expect(resolveCanvasKey(cmd("v"))).toEqual({ type: "paste" });
    expect(resolveCanvasKey(cmd("d"))).toEqual({ type: "duplicate" });
    expect(resolveCanvasKey(cmd("a"))).toEqual({ type: "selectAllOnPage" });
    expect(resolveCanvasKey(cmd("g"))).toEqual({ type: "goToPageDialog" });
    expect(resolveCanvasKey(cmd("p"))).toEqual({ type: "print" });
    expect(resolveCanvasKey(cmd("f"))).toEqual({ type: "find" });
  });

  test("zoom keys, shifted or not", () => {
    for (const k of ["=", "+"]) expect(resolveCanvasKey(cmd(k))).toEqual({ type: "zoom", direction: "in" });
    for (const k of ["-", "_"]) expect(resolveCanvasKey(cmd(k))).toEqual({ type: "zoom", direction: "out" });
    expect(resolveCanvasKey(cmd("0"))).toEqual({ type: "fitWidth" });
    expect(resolveCanvasKey(cmd("1"))).toEqual({ type: "actualSize" });
    expect(resolveCanvasKey(key("="))).toBeNull();
  });

  test("tool letters fire only without a modifier", () => {
    const tools: Array<[string, string]> = [
      ["v", "select"],
      ["h", "highlight"],
      ["u", "underline"],
      ["i", "ink"],
      ["g", "signature"],
      ["s", "stamp"],
      ["r", "rect"],
      ["c", "callout"],
      ["t", "text"],
    ];
    for (const [k, tool] of tools) {
      expect(resolveCanvasKey(key(k))).toEqual({ type: "tool", tool });
      expect(resolveCanvasKey(key(k.toUpperCase()))).toEqual({ type: "tool", tool });
    }
    for (const k of ["h", "s", "t", "u", "i", "r"]) expect(resolveCanvasKey(cmd(k))).toBeNull();
  });

  test("Shift+U is strikethrough, U underline", () => {
    expect(resolveCanvasKey(key("U", { shiftKey: true }))).toEqual({ type: "tool", tool: "strikethrough" });
    expect(resolveCanvasKey(key("u"))).toEqual({ type: "tool", tool: "underline" });
  });

  test("J and K move between pages", () => {
    expect(resolveCanvasKey(key("j"))).toEqual({ type: "page", delta: 1 });
    expect(resolveCanvasKey(key("K"))).toEqual({ type: "page", delta: -1 });
    expect(resolveCanvasKey(cmd("j"))).toBeNull();
  });

  test("arrows nudge by one point, ten with Shift, never with Cmd", () => {
    expect(resolveCanvasKey(key("ArrowLeft"))).toEqual({ type: "nudge", dx: -1, dy: 0, repeat: false });
    expect(resolveCanvasKey(key("ArrowDown", { shiftKey: true, repeat: true }))).toEqual({
      type: "nudge",
      dx: 0,
      dy: 10,
      repeat: true,
    });
    expect(resolveCanvasKey(cmd("ArrowUp"))).toBeNull();
  });

  test("Delete and Backspace remove the selection", () => {
    expect(resolveCanvasKey(key("Delete"))).toEqual({ type: "delete" });
    expect(resolveCanvasKey(key("Backspace"))).toEqual({ type: "delete" });
  });

  test("Enter places the armed tool only when bare", () => {
    expect(resolveCanvasKey(key("Enter"))).toEqual({ type: "placeArmedTool" });
    expect(resolveCanvasKey(key("Enter", { shiftKey: true }))).toBeNull();
    expect(resolveCanvasKey(cmd("Enter"))).toBeNull();
  });

  test("Space pans, and a held Space does not restart it", () => {
    expect(resolveCanvasKey(key(" ", { code: "Space" }))).toEqual({ type: "spacePan", repeat: false });
    expect(resolveCanvasKey(key(" ", { code: "Space", repeat: true }))).toEqual({ type: "spacePan", repeat: true });
  });

  test("the shortcut sheet opens on each modifier-slash variant", () => {
    expect(resolveCanvasKey(cmd("?", { shiftKey: true }))).toEqual({ type: "shortcuts" });
    expect(resolveCanvasKey(cmd("？"))).toEqual({ type: "shortcuts" });
    expect(resolveCanvasKey(cmd("/", { code: "Slash" }))).toEqual({ type: "shortcuts" });
  });

  test("Escape, bare only", () => {
    expect(resolveCanvasKey(key("Escape"))).toEqual({ type: "escape" });
    expect(resolveCanvasKey(cmd("Escape"))).toBeNull();
  });

  test("an unbound Cmd key is left to the app and the system", () => {
    expect(resolveCanvasKey(cmd("s"))).toBeNull();
    expect(resolveCanvasKey(cmd("w"))).toBeNull();
    expect(resolveCanvasKey(key("x"))).toBeNull();
  });
});
