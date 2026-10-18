import { useCallback, useSyncExternalStore } from "react";
import type { Overlay, PdfRect } from "../../../pdf/model/types";
import { resizeOverlayGeometry } from "../../overlays/geometry";

export type TransientOverlayGeometry = {
  rect?: PdfRect;
  angle?: number;
};

const geometryByOverlayId = new Map<string, TransientOverlayGeometry>();
const listenersByOverlayId = new Map<string, Set<() => void>>();

export function getTransientOverlayGeometry(
  overlayId: string,
): TransientOverlayGeometry | null {
  return geometryByOverlayId.get(overlayId) ?? null;
}

export function setTransientOverlayGeometry(
  overlayId: string,
  geometry: TransientOverlayGeometry,
) {
  geometryByOverlayId.set(overlayId, geometry);
  for (const listener of listenersByOverlayId.get(overlayId) ?? []) listener();
}

export function clearTransientOverlayGeometry(overlayId: string) {
  if (!geometryByOverlayId.delete(overlayId)) return;
  for (const listener of listenersByOverlayId.get(overlayId) ?? []) listener();
}

function subscribeTransientOverlayGeometry(
  overlayId: string,
  listener: () => void,
) {
  const listeners = listenersByOverlayId.get(overlayId) ?? new Set();
  listeners.add(listener);
  listenersByOverlayId.set(overlayId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) listenersByOverlayId.delete(overlayId);
  };
}

export function useTransientOverlayGeometry(overlayId: string) {
  const subscribe = useCallback(
    (listener: () => void) =>
      subscribeTransientOverlayGeometry(overlayId, listener),
    [overlayId],
  );
  const getSnapshot = useCallback(
    () => getTransientOverlayGeometry(overlayId),
    [overlayId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function applyTransientOverlayGeometry(
  overlay: Overlay,
  transient: TransientOverlayGeometry | null,
): Overlay {
  if (!transient) return overlay;
  let preview = overlay;
  if (transient.rect) {
    preview = {
      ...preview,
      ...resizeOverlayGeometry(overlay, transient.rect),
    } as Overlay;
  }
  if (transient.angle !== undefined) {
    preview = { ...preview, angle: transient.angle } as Overlay;
  }
  return preview;
}
