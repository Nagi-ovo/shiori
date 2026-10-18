/**
 * The phone's floating chrome: where the tool/inspector panel sits, and how
 * the three things that can share the bottom edge stay out of each other's
 * way.
 *
 * Nothing here is ever in the toolbar's document flow. That is what removes
 * the 26.9.7 placeholder problem at the root — chrome that is never in the
 * flow cannot move the document when it appears — and it is why entering
 * and leaving annotation mode does not shift the reading position either.
 *
 * The three tenants of the bottom edge:
 *   - the panel: full width, holds the tool grid and/or the inspector;
 *   - the annotate button: a 48px circle at the right, above the panel;
 *   - the page pill: a narrow chip, centred, above the panel.
 * Only the panel is wide enough to collide with the other two, so both
 * stack above it and neither stacks above the other. At the narrowest phone
 * (320 CSS px) the widest pill spans about 99-221 and the button 260-308.
 */

export type FloatingInspectorPlacement = "top" | "bottom";

/** Vertical box in viewport coordinates — a DOMRect satisfies it. */
export type VerticalBox = { top: number; bottom: number };

/** Gap between the panel and the edge it is anchored to. */
export const FLOATING_INSPECTOR_EDGE_GAP = 12;

/** What the panel is carrying. Nothing at all means it does not render. */
export type FloatingPanelContents = { toolGrid: boolean; inspector: boolean };

// One inspector row and two rows of tool buttons, at the 44px touch minimum
// app.css clamps them to, plus the panel's own padding.
//
// Constants rather than measurements: each part keeps its controls on a
// fixed number of lines (the inspector scrolls sideways rather than
// wrapping, the grid is always 4+2), so the height does not vary by tool,
// and measuring would mean a resize observer feeding back into the layout
// that produced it.
const INSPECTOR_ROW_HEIGHT = 68;
const TOOL_GRID_HEIGHT = 100;

/**
 * The room the panel occupies at the edge it takes, including the gap
 * between it and that edge. Zero when it renders nothing.
 */
export function floatingPanelBand({
  toolGrid,
  inspector,
}: FloatingPanelContents): number {
  if (!toolGrid && !inspector) return 0;
  return (
    FLOATING_INSPECTOR_EDGE_GAP +
    (toolGrid ? TOOL_GRID_HEIGHT : 0) +
    (inspector ? INSPECTOR_ROW_HEIGHT : 0)
  );
}

/** The inspector on its own — the default clearance for the flip decision. */
export const FLOATING_INSPECTOR_BAND = floatingPanelBand({
  toolGrid: false,
  inspector: true,
});

export function floatingInspectorPlacement({
  selection,
  viewport,
  band = FLOATING_INSPECTOR_BAND,
}: {
  /**
   * The selected annotation's on-screen box, or null when a tool inspector
   * is showing — a tool has drawn nothing yet, so there is no target to
   * keep clear.
   */
  selection: VerticalBox | null;
  /** The document viewport's on-screen box. */
  viewport: VerticalBox;
  band?: number;
}): FloatingInspectorPlacement {
  if (!selection) return "bottom";
  const hitsBottom = selection.bottom > viewport.bottom - band;
  const hitsTop = selection.top < viewport.top + band;
  // The panel edits the selected annotation, so covering it hides the very
  // change being made. Move to the other edge when exactly one is in the
  // way. When the annotation reaches both bands (a page-tall rectangle) or
  // neither, the bottom wins: it is the edge a thumb reaches.
  if (hitsBottom && !hitsTop) return "top";
  return "bottom";
}

// The page pill and this panel both hang off the bottom edge, and the panel
// is the interactive one, so the pill yields. The panel publishes how much
// bottom room it is taking and PageIndicatorPill adds it to its own offset.
//
// A dedicated micro-store, in the shape of liveZoomIndicator: putting this
// in the editor store would re-render the document on every tool change,
// and prop-drilling it would mean routing a toolbar detail through App.
let bottomInset = 0;
const listeners = new Set<() => void>();

export function setFloatingInspectorBottomInset(px: number): void {
  if (bottomInset === px) return;
  bottomInset = px;
  for (const listener of listeners) listener();
}

export function subscribeFloatingInspectorBottomInset(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getFloatingInspectorBottomInset(): number {
  return bottomInset;
}

/** The annotate / done button: a circle at the bottom-right. */
export const ANNOTATE_BUTTON_SIZE = 48;

/**
 * Where the annotate button sits: its own gap above whatever the panel took,
 * so entering annotation mode lifts it clear of the grid it just opened
 * rather than parking it on top.
 */
export function annotateButtonBottom(panelBand: number): string {
  return `calc(${FLOATING_INSPECTOR_EDGE_GAP + panelBand}px + var(--shiori-safe-bottom, 0px))`;
}

/** The page pill's own gap from the bottom edge, with nothing else there. */
export const PAGE_PILL_EDGE_GAP = 16;

/**
 * Where the page pill sits once the panel has taken what it needs. Lives
 * here rather than in the pill so the two halves of the bottom edge are
 * described in one place — and so it can be asserted directly: happy-dom
 * drops `var()` from inline styles, so the rendered value cannot be read
 * back in a test.
 */
export function pagePillBottom(panelBand: number): string {
  return `calc(${PAGE_PILL_EDGE_GAP + panelBand}px + var(--shiori-safe-bottom, 0px))`;
}
