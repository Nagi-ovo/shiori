import { createContext, useContext } from "react";
import type { RefObject } from "react";

export const ScrollerContext = createContext<RefObject<HTMLElement | null> | null>(
  null,
);

export function useScroller(): HTMLElement | null {
  return useContext(ScrollerContext)?.current ?? null;
}
