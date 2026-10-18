import { useEffect } from "react";

import { applyDisplayStyle, applyTheme, type EffectiveTheme } from "../../design/theme";
import { useEffectiveTheme } from "../../editor/hooks/useEffectiveTheme";
import { syncImmersiveMode } from "../../platform/immersive";
import { syncNativeTheme } from "../../platform/theme";
import { useAppStore, type PrefsTheme } from "../../editor/store/store";

/**
 * Applies visual appearance to the DOM and native shell from user prefs:
 * the colour palette (theme + accent), the serif-accent display style, and
 * the reader-mode immersive toggle (hide the OS status/navigation bars).
 *
 * Extracted verbatim from the App God-component.
 * Every effect here is a one-way write — the hook owns no component state and
 * registers no listeners — so pulling it out is behaviour-preserving no matter
 * where the hook is called. It returns the resolved theme values the rest of
 * App still reads (e.g. the markdown palette computation).
 */
export function useAppearance(readerMode: boolean): {
  effectiveTheme: EffectiveTheme;
  prefsTheme: PrefsTheme;
} {
  const prefsColorMode = useAppStore((s) => s.prefs.colorMode);
  const prefsTheme = useAppStore((s) => s.prefs.theme);
  const prefsAccentColor = useAppStore((s) => s.prefs.accentColor);
  const prefsSerifAccents = useAppStore((s) => s.prefs.serifAccents);
  const effectiveTheme = useEffectiveTheme(prefsColorMode);

  // Reapply the CSS palette whenever the effective mode or theme changes.
  // useEffectiveTheme subscribes to OS changes while Auto is selected. Also
  // forwards the effective theme to the native window so macOS repaints the
  // title-bar area (otherwise the chrome goes dark but the OS-drawn frame
  // stays light).
  useEffect(() => {
    applyTheme(effectiveTheme, prefsTheme, prefsAccentColor);
    void syncNativeTheme(effectiveTheme);
  }, [effectiveTheme, prefsAccentColor, prefsTheme]);

  useEffect(() => {
    applyDisplayStyle(prefsSerifAccents);
  }, [prefsSerifAccents]);

  // Android: reader mode should also hide the OS status/navigation bars —
  // in-app chrome removal alone leaves the battery bar visible on tablets.
  useEffect(() => {
    syncImmersiveMode(readerMode);
  }, [readerMode]);

  return { effectiveTheme, prefsTheme };
}
