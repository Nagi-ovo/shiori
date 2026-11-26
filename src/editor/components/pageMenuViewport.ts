import type { PageMenuSafeInsets, PageMenuViewport } from "./pageMenuPlacement";

/** The visual viewport the page menu is placed in, in CSS pixels. */
export function pageMenuViewport(): PageMenuViewport {
  const viewport = window.visualViewport;
  return {
    left: viewport?.offsetLeft ?? 0,
    top: viewport?.offsetTop ?? 0,
    width: viewport?.width ?? window.innerWidth,
    height: viewport?.height ?? window.innerHeight,
  };
}

/** Resolve env(safe-area-inset-*) through a real CSS property. Reading the
 * custom property directly can return the unevaluated `env(...)` token. */
export function pageMenuSafeInsets(): PageMenuSafeInsets {
  const probe = document.createElement("div");
  probe.style.cssText = [
    "position:fixed",
    "visibility:hidden",
    "pointer-events:none",
    "padding-top:var(--shiori-safe-top, 0px)",
    "padding-right:var(--shiori-safe-right, 0px)",
    "padding-bottom:var(--shiori-safe-bottom, 0px)",
    "padding-left:var(--shiori-safe-left, 0px)",
  ].join(";");
  document.body.append(probe);
  const style = window.getComputedStyle(probe);
  const insets = {
    top: nonNegativeCssPixel(style.paddingTop),
    right: nonNegativeCssPixel(style.paddingRight),
    bottom: nonNegativeCssPixel(style.paddingBottom),
    left: nonNegativeCssPixel(style.paddingLeft),
  };
  probe.remove();
  return insets;
}

function nonNegativeCssPixel(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}
