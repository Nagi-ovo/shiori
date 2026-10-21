import { useSyncExternalStore } from "react";

const read = () => window.devicePixelRatio || 1;

const listeners = new Set<() => void>();
let unwatch: (() => void) | null = null;

// One watcher for every mounted page. A `(resolution: Ndppx)` query matches
// only the ratio it was built for, so it fires once when the ratio leaves it
// (the window moved to another monitor, browser zoom) and is rebuilt for the
// new one. The -webkit- form covers WebKit before Safari 16. Resize is a
// cheap second signal: subscribers re-read the ratio and React drops the
// update when it did not change.
function watch(): () => void {
  let query: MediaQueryList | null = null;
  let armedFor = 0;
  const arm = () => {
    query?.removeEventListener("change", onChange);
    armedFor = read();
    query =
      typeof window.matchMedia === "function"
        ? window.matchMedia(
            `(resolution: ${armedFor}dppx), (-webkit-device-pixel-ratio: ${armedFor})`,
          )
        : null;
    query?.addEventListener("change", onChange);
  };
  const onChange = () => {
    if (read() !== armedFor) arm();
    for (const listener of [...listeners]) listener();
  };
  arm();
  window.addEventListener("resize", onChange);
  return () => {
    query?.removeEventListener("change", onChange);
    window.removeEventListener("resize", onChange);
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  unwatch ??= watch();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    unwatch?.();
    unwatch = null;
  };
}

/** window.devicePixelRatio, re-rendering when it changes. */
export function useDevicePixelRatio(): number {
  return useSyncExternalStore(subscribe, read, read);
}
