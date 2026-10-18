import { useEffect, useState } from "react";
import { IS_TABLET } from "../../platform";

// Treat compact viewports as the mobile-style editor layout. The
// three-panel PDF shell needs room for the thumbnails/right rail plus a
// readable page canvas; below this threshold those rails become drawers
// and must not auto-open over the document. This is intentionally based
// on CSS viewport width, not platform: large tablets can keep the
// desktop-like layout, while a narrow desktop window behaves compactly.
export const MOBILE_MAX_WIDTH = 959;
const MOBILE_QUERY = `(max-width: ${MOBILE_MAX_WIDTH}px)`;

function readInitial(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia(MOBILE_QUERY).matches;
}

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(readInitial);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}

/**
 * The window's width, for layout budgets that are a *function* of it rather
 * than a breakpoint over it — the navigator and rail ceilings, which have to
 * add up to less than the window with a readable page still between them.
 *
 * matchMedia cannot serve those: dragging a window from 1600 to 1000 crosses
 * no query, yet invalidates every clamp.
 *
 * Committed on the trailing edge, NOT per frame. When App read this value,
 * every commit re-rendered the whole editor and re-measured the page canvas;
 * doing that once per animation frame while a window was being dragged froze
 * the app on a large document. The navigator reads it now, and the clamp it
 * feeds still only has to be right once the window has settled — mid-drag
 * the gutter keeps its old width, which is exactly what it did before this
 * hook existed.
 */
const RESIZE_SETTLE_MS = 140;

export function useViewportWidth(): number {
  const [width, setWidth] = useState<number>(() =>
    typeof window === "undefined" ? 0 : window.innerWidth,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    let timer: number | null = null;
    const commit = () =>
      setWidth((current) =>
        current === window.innerWidth ? current : window.innerWidth,
      );
    const onResize = () => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(commit, RESIZE_SETTLE_MS);
    };
    // The window can also have been resized between first paint and this
    // effect (restoring a maximised window, an OS-driven resize on launch).
    commit();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (timer != null) window.clearTimeout(timer);
    };
  }, []);

  return width;
}

// A "phone" is a compact viewport that is NOT a tablet: a real phone, or a
// narrow desktop window. Tablets (IS_TABLET, form-factor detected) report
// isMobile=true at portrait widths but have room for the desktop-style chrome
// — inline filename, an unstretched tool pill — so the phone-only space-saving
// layouts (second-line filename, full-width 4-col tool grid) would look broken
// and wasteful on them. Use this to gate those phone-only layouts; keep plain
// useIsMobile for touch sizing (larger hit targets), which tablets DO want.
export function useIsPhone(): boolean {
  return useIsMobile() && !IS_TABLET;
}

// Shared max-width media-query subscription. Every breakpoint hook below is
// the same three lines otherwise.
function useMaxWidth(px: number): boolean {
  const query = `(max-width: ${px}px)`;
  const [matches, setMatches] = useState<boolean>(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

// Above MOBILE_MAX_WIDTH the layout is still the desktop one, but between
// roughly 960 and this width the tool pill runs out of room: each button is
// icon + label + keyboard-hint chip, and the label is what gives way — it
// wraps to a second line and the whole toolbar grows to two rows.
//
// The hint chip is the least valuable thing in that button (the label names
// the tool; the letter is a bonus), so it is the first thing dropped, exactly
// as it already is on mobile. Chosen by measuring the widest locale: the
// German/Japanese labels plus hints stop fitting a little under this.
// Below this the embedded terminal cannot be shown without squeezing the
// document into uselessness. The rail already refuses to size the terminal
// under TERMINAL_RAIL_MIN_WIDTH (360) and always reserves 420 for the page,
// so 900 is where those two stop both being satisfiable with any margin.
//
// The window used to enforce this instead, via minWidth: 960 in
// tauri.conf.json — which taxed every window on every machine for one
// optional panel, and (being 1px above MOBILE_MAX_WIDTH) made the compact
// layout unreachable on desktop entirely. Panels manage themselves; the
// window minimum belongs to the primary content.
export const TERMINAL_MIN_VIEWPORT_WIDTH = 900;

export function useTerminalFitsViewport(): boolean {
  return !useMaxWidth(TERMINAL_MIN_VIEWPORT_WIDTH - 1);
}

export const COMPACT_TOOLBAR_MAX_WIDTH = 1180;

export function useIsCompactToolbar(): boolean {
  return useMaxWidth(COMPACT_TOOLBAR_MAX_WIDTH);
}
