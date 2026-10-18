import { useEffect, useState } from "react";

// True when the primary pointer is coarse (finger / stylus) rather than a
// precise mouse. Unlike `useIsMobile` (a viewport-width heuristic), this is
// about input precision: a touch laptop or a tablet in a desktop-width layout
// still needs finger-sized hit targets. Used to grow the otherwise-tiny
// selection/resize/rotate handles into a comfortable touch target without
// bloating them on a mouse-driven desktop.
const COARSE_QUERY = "(pointer: coarse)";

function readInitial(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(COARSE_QUERY).matches;
}

export function useIsCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState<boolean>(readInitial);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(COARSE_QUERY);
    const onChange = (e: MediaQueryListEvent) => setCoarse(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return coarse;
}
