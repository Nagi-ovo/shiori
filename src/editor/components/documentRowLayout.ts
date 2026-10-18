import type { CSSProperties } from "react";

/**
 * The room a phone's home indicator (iOS `env()`) or system navigation bar
 * (Android, published by the shell — see `platform/androidShell.ts`) needs
 * at the bottom of the window. Zero on desktop.
 */
export const SAFE_BOTTOM = "var(--shiori-safe-bottom, 0px)";

/**
 * Every document row reserves the bottom safe area. Docx and the text kinds
 * have always used this; the PDF row used to get it for free from the status
 * bar's own padding, and inherited this the day that bar became desktop-only.
 *
 * 26.9.8 shipped the failure this prevents: content sitting under the system
 * navigation bar, which readers noticed immediately.
 */
export const SAFE_BOTTOM_ROW_STYLE: CSSProperties = {
  paddingBottom: SAFE_BOTTOM,
};

export type PdfDocumentRowStyleOptions = {
  readerMode: boolean;
  /** macOS traffic-light clearance, in px — reader mode hides the top bar. */
  trafficLightInsetTop: number;
  /** The top safe-area inset to add in reader mode; "0px" off-device. */
  safeTop: string;
};

/**
 * The PDF branch's document-row padding.
 *
 * Reader mode drops all four edges of chrome, so the row itself has to hold
 * every safe-area inset open. Outside reader mode the top bar and navigator
 * cover their own edges — but nothing covers the bottom any more, so that
 * one inset is reserved unconditionally, exactly as the other document kinds
 * do through SAFE_BOTTOM_ROW_STYLE.
 */
export function pdfDocumentRowStyle({
  readerMode,
  trafficLightInsetTop,
  safeTop,
}: PdfDocumentRowStyleOptions): CSSProperties {
  return {
    paddingTop: readerMode
      ? `calc(${trafficLightInsetTop}px + ${safeTop})`
      : trafficLightInsetTop,
    paddingBottom: SAFE_BOTTOM,
    paddingLeft: readerMode ? "var(--shiori-safe-left, 0px)" : undefined,
    paddingRight: readerMode ? "var(--shiori-safe-right, 0px)" : undefined,
  };
}
