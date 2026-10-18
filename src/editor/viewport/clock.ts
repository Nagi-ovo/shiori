/**
 * Timers for the viewport modules. They take a Clock instead of reaching for
 * `window.setTimeout`, so tests drive time with a fake clock and assert no
 * wall-clock timing.
 */
export type TimerHandle = number;

export type Clock = {
  /** Milliseconds, monotonic; only differences are meaningful. */
  now(): number;
  setTimeout(run: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
};

export const systemClock: Clock = {
  now: () => performance.now(),
  setTimeout: (run, ms) => window.setTimeout(run, ms),
  clearTimeout: (handle) => window.clearTimeout(handle),
};
