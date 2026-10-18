import { useEffect, useState } from "react";

// Returns a Date.now() value that updates on the given interval.
// Used for countdown displays ("47h left") that should tick without wiring
// a manual setInterval per component.
export function useNow(intervalMs: number = 60_000): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
