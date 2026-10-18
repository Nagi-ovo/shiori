import { IS_ANDROID, IS_IOS, IS_MAC } from "./index";

/**
 * Windows and Linux draw classic scrollbars: permanent, wide, grey-on-grey,
 * with arrow buttons. macOS, iOS and Android use overlay bars that fade out,
 * and app.css deliberately leaves those alone. Web and desktop alike: Chrome
 * on Windows looks the same as the WebView2 shell.
 */
export function usesClassicScrollbars(): boolean {
  return !IS_MAC && !IS_IOS && !IS_ANDROID;
}

/** Lets app.css slim the classic bars without touching overlay platforms. */
export function markScrollbarStyle(root: HTMLElement): void {
  if (usesClassicScrollbars()) root.dataset.shioriScrollbars = "classic";
}
