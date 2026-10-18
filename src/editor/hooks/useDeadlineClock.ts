import { useEffect, useReducer } from "react";

/**
 * A clock that only ticks when something on screen is about to change.
 *
 * Returns the current time as React state. `nextChangeAt(now)` says when the
 * caller's output next differs; the hook re-renders once at that instant,
 * with a fresh `now`, and the caller names the next deadline again. A null
 * deadline schedules nothing, so an idle caller costs no commits at all —
 * unlike the fixed 500ms interval this replaced, which committed the status
 * bar ten times per five seconds with nothing to show.
 *
 * A deadline already in the past means the stored `now` is stale (a new
 * input arrived, or the timestamp jumped); the clock ticks at once. While the
 * page is hidden the timer is dropped and re-armed, or caught up, on return.
 */
export function useDeadlineClock(
  nextChangeAt: (now: number) => number | null,
): number {
  const [now, tick] = useReducer(() => Date.now(), undefined, () => Date.now());
  const deadline = nextChangeAt(now);
  useEffect(() => {
    if (deadline === null) return;
    let timer: number | null = null;
    const disarm = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };
    const arm = () => {
      disarm();
      const wait = deadline - Date.now();
      if (wait <= 0) {
        tick();
        return;
      }
      timer = window.setTimeout(() => {
        timer = null;
        tick();
      }, wait);
    };
    const onVisibility = () => {
      if (document.hidden) disarm();
      else arm();
    };
    if (!document.hidden) arm();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disarm();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [deadline]);
  return now;
}
