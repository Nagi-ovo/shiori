import { useCallback, useSyncExternalStore } from "react";
import type { DragState } from "../../overlays/dragState";

// The in-flight geometry of a creation gesture — the ink stroke being drawn,
// the marquee being swept, the box being pulled out for a new annotation.
//
// It lives here rather than in OverlayLayer's `drag` state for the reason
// docs/POSTMORTEMS.md 2026-07-30 gives: a pointer-tracking interaction cannot
// afford a setState in its frame loop, because the cost is not the state write
// but the subtree it re-renders. Only the preview layer subscribes, so a
// gesture repaints the preview and nothing else — the annotations, the page
// canvas and the layer itself all stay put.
const NONE: DragState = { kind: "none" };

// Keyed by page: one OverlayLayer is mounted per visible page, so an unkeyed
// channel would paint the same in-flight stroke onto every page at once.
let activePageId: string | null = null;
let preview: DragState = NONE;
const listeners = new Set<() => void>();

export function getTransientDragPreview(pageId: string): DragState {
  return activePageId === pageId ? preview : NONE;
}

export function setTransientDragPreview(pageId: string, next: DragState) {
  activePageId = next.kind === "none" ? null : pageId;
  preview = next;
  for (const listener of listeners) listener();
}

export function clearTransientDragPreview() {
  if (preview.kind === "none") return;
  activePageId = null;
  preview = NONE;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useTransientDragPreview(pageId: string): DragState {
  const snapshot = useCallback(
    () => getTransientDragPreview(pageId),
    [pageId],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
