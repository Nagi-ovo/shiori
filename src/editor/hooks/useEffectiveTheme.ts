import { useSyncExternalStore } from "react";
import { resolveEffectiveTheme, type EffectiveTheme } from "../../design/theme";
import type { PrefsColorMode } from "../store/store";

const COLOR_SCHEME_QUERY = "(prefers-color-scheme: dark)";

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => undefined;
  const media = window.matchMedia(COLOR_SCHEME_QUERY);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}

function snapshot(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean(window.matchMedia?.(COLOR_SCHEME_QUERY).matches)
  );
}

export function useEffectiveTheme(colorMode: PrefsColorMode): EffectiveTheme {
  const systemPrefersDark = useSyncExternalStore(subscribe, snapshot, () => false);
  return resolveEffectiveTheme(colorMode, systemPrefersDark);
}
