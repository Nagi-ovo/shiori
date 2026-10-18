// Dev-only zoom diagnostics tap. Batches NDJSON event lines to the vite dev
// server's in-memory collector (see zoomDebugCollector in vite.config.ts) so
// a real device's gesture stream can be read back with a plain GET, without
// the reader having to look at anything. Compiled out of release builds:
// every call is behind import.meta.env.DEV, and the queue never forms there.
let queue: string[] = [];
let flushTimer: number | null = null;
let sequence = 0;

export function zoomDebugTap(
  kind: string,
  data?: Record<string, unknown>,
): void {
  if (!import.meta.env.DEV) return;
  if (typeof window === "undefined") return;
  queue.push(
    JSON.stringify({
      seq: (sequence += 1),
      t: Math.round(performance.now()),
      kind,
      ...data,
    }),
  );
  if (queue.length > 800) queue.splice(0, queue.length - 800);
  if (flushTimer !== null) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    const body = queue.join("\n");
    queue = [];
    fetch("/__shiori_zoom_debug", {
      method: "POST",
      body,
      keepalive: true,
    }).catch(() => {
      // The collector only exists under the dev server; stay silent.
    });
  }, 250);
}
