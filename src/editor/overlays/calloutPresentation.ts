import { useEffect, useState } from "react";
import { prefersReducedLiveOverlayMotion } from "../../live/overlayReveal";

/** Duration of the collapse/expand morph. Shared by the card and the leader. */
export const CALLOUT_DISCLOSURE_MS = 190;

/** Pointer travel that turns a tap on a collapsed seal into a drag. */
export const COLLAPSED_CALLOUT_DRAG_THRESHOLD_PX = 4;

/**
 * True only for the duration of a collapse/expand morph.
 *
 * The card's box transition MUST be gated on this. Left/top/width/height also
 * change while the user drags a resize handle and while the page zooms, and an
 * always-on transition makes the card ease along ~190ms behind the pointer
 * while the leader — which has no transition — tracks it exactly.
 */
export function useCalloutDisclosureMorph(collapsed: boolean): boolean {
  const [previous, setPrevious] = useState(collapsed);
  const [morphing, setMorphing] = useState(false);
  if (previous !== collapsed) {
    setPrevious(collapsed);
    setMorphing(true);
  }
  useEffect(() => {
    if (!morphing) return;
    const handle = window.setTimeout(
      () => setMorphing(false),
      CALLOUT_DISCLOSURE_MS,
    );
    return () => window.clearTimeout(handle);
  }, [morphing, collapsed]);
  return morphing;
}

/**
 * Whether the leader line should still aim at the collapsed seal.
 *
 * Collapsing is instant: the longer, seal-anchored leader is revealed from
 * under the shrinking card. Expanding has to wait — if the leader snapped back
 * to the label edge immediately, a gap would open between the seal and the line
 * for exactly one transition, until the card grew over that segment.
 */
export function useCalloutLeaderCollapsed(collapsed: boolean): boolean {
  const [lagged, setLagged] = useState(collapsed);
  // Arm during render, not in an effect: collapsing is instant, so the flag
  // must already be set by the time an expand arrives (React's "adjust state
  // while rendering" pattern — same component, no cascading render).
  if (collapsed && !lagged) setLagged(true);
  useEffect(() => {
    if (collapsed) return;
    const ms = prefersReducedLiveOverlayMotion() ? 0 : CALLOUT_DISCLOSURE_MS;
    const handle = window.setTimeout(() => setLagged(false), ms);
    return () => window.clearTimeout(handle);
  }, [collapsed]);
  return collapsed || lagged;
}
