import { useEffect } from "react";

/**
 * Native-feel chrome guard: suppress the browser's default
 * right-click context menu across the app so a desktop build never leaks the
 * WebView's "Reload / Back / Inspect Element" menu on the reader chrome.
 *
 * Editable fields keep their native menu — users expect copy/paste/spellcheck
 * inside inputs, textareas and contenteditable regions. App-provided custom
 * menus are unaffected: they render their own overlay rather than relying on
 * the browser default, and a component that handles `contextmenu` itself
 * (stopPropagation) shortcuts this window-level listener entirely.
 */
export function useSuppressBrowserContextMenu(): void {
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const editable =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (editable) return;
      e.preventDefault();
    };
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);
}
