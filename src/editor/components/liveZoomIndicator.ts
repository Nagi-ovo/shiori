// A live pinch/wheel gesture changes only compositor transforms; the real
// zoom state commits once, when the gesture settles. The toolbar readout must
// still track the fingers in between, so the gesture code publishes its
// per-frame visual scale here and the readout subscribes. A dedicated
// micro-store keeps those per-frame updates from re-rendering anything beyond
// the readout itself — putting this in App or editor-store state would run a
// large subtree once per gesture frame.
let liveZoom: number | null = null;
const listeners = new Set<() => void>();

export function setLiveZoomIndicator(value: number | null): void {
  if (liveZoom === value) return;
  liveZoom = value;
  for (const listener of listeners) listener();
}

export function subscribeLiveZoomIndicator(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getLiveZoomIndicator(): number | null {
  return liveZoom;
}
