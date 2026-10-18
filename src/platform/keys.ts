// Cross-platform modifier key helpers.
// Keep the design tokens (⌘, ⇧, ⌥) throughout the source so macOS users see
// the symbols they expect; swap to verbose labels for Windows/Linux through
// k(). Everything else (keydown handlers) already uses e.metaKey || e.ctrlKey.
//
// All t() output is additionally routed through k() by the "platformKeys"
// i18next post-processor (src/i18n/index.ts), so locale strings may carry the
// Mac glyphs directly — consumers do not need to wrap t() themselves.

const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPod|iPhone|iPad/.test(navigator.platform);

export const IS_MAC = isMac;

export const MOD = isMac ? "⌘" : "Ctrl";
export const ALT = isMac ? "⌥" : "Alt";
export const SHIFT = isMac ? "⇧" : "Shift";
export const ESC = "Esc";

// Replace Mac symbols with platform-appropriate labels. Keeps ⌫ as-is
// (Backspace glyph is universal enough).
//
// Modifier order differs per platform. Apple's HIG lists modifiers as
// Ctrl, Option, Shift, Command — so ⇧⌘Z reads correctly on macOS.
// Windows/Linux convention puts Ctrl first (Ctrl+Shift+Z, Ctrl+Alt+Del),
// so after symbol substitution we reorder to Ctrl, Alt, Shift.
// Non-Mac conversion, exported separately so tests can exercise it without
// depending on the host platform. A "+" is inserted where a glyph directly
// abuts the next token ("⇧⌘Z" → "Ctrl+Shift+Z"); glyphs followed by spaces or
// punctuation keep their original separator ("⌘ ?" → "Ctrl ?", "⌘+drag" →
// "Ctrl+drag"). Strings without glyphs pass through untouched, which keeps the
// global i18next post-processing safe for ordinary prose.
export function convertKeyGlyphs(label: string): string {
  return label
    .replace(/([⌘⇧⌥⌃])(?=[A-Za-z0-9⌘⇧⌥⌃])/g, "$1+")
    .replace(/⌘/g, "Ctrl")
    .replace(/⇧/g, "Shift")
    .replace(/⌥/g, "Alt")
    .replace(/⌃/g, "Ctrl")
    .replace(/Shift([+\s]*)Alt/g, "Alt$1Shift")
    .replace(/Shift([+\s]*)Ctrl/g, "Ctrl$1Shift")
    .replace(/Alt([+\s]*)Ctrl/g, "Ctrl$1Alt");
}

export function k(label: string): string {
  return isMac ? label : convertKeyGlyphs(label);
}
