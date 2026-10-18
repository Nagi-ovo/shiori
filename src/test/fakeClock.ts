import type { Clock, TimerHandle } from "../editor/viewport/clock";

/**
 * A Clock whose time moves only when a test calls `advance`. Timers fire in
 * due order, each at its own due time, including timers a firing timer sets.
 */
export function fakeClock(start = 0): Clock & {
  advance(ms: number): void;
  pending(): number;
} {
  let now = start;
  let nextHandle = 1;
  const timers = new Map<TimerHandle, { due: number; run: () => void }>();
  return {
    now: () => now,
    setTimeout(run, ms) {
      const handle = nextHandle++;
      timers.set(handle, { due: now + Math.max(0, ms), run });
      return handle;
    },
    clearTimeout(handle) {
      timers.delete(handle);
    },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        let next: [TimerHandle, { due: number; run: () => void }] | null = null;
        for (const entry of timers) {
          if (entry[1].due <= until && (!next || entry[1].due < next[1].due)) next = entry;
        }
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].due;
        next[1].run();
      }
      now = until;
    },
    pending: () => timers.size,
  };
}
