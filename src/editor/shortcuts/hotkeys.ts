type ShortcutEvent = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey?: boolean;
  code?: string;
};

// Accept any of: ⌘? / Ctrl+?, the fullwidth ⌘？ (Chinese IM), and
// ⌘/ / Ctrl+/ without shift. The last form matters because:
//   - macOS reserves `⌘+Shift+/` for the Help → Search menu, which
//     eats the event before the WebView sees it on apps that ship a
//     menu (and Tauri's default menu does ship Help);
//   - WKWebView sometimes reports `key === "/"` rather than `"?"` even
//     when Shift is held, depending on layout + IME state;
//   - ⌘/ is single-finger and layout-independent, a sane fallback.
// So the sheet opens on any reasonable variant of "modifier + slash".
export function isShortcutsHotkey(e: ShortcutEvent): boolean {
  if (!e.metaKey && !e.ctrlKey) return false;
  if (e.key === "?" || e.key === "？") return true;
  if (e.key === "/" || e.code === "Slash") return true;
  return false;
}

export function isFindHotkey(e: ShortcutEvent): boolean {
  return (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f";
}

export function isPrintHotkey(e: ShortcutEvent): boolean {
  return (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p";
}
