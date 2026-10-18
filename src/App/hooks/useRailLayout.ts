import { useCallback, useEffect } from "react";
import { useAppStore, useEditorStore, type RailTab } from "../../editor/store/store";
import { CAPABILITIES } from "../../platform";

/**
 * The two side panels and the buttons that open them: the left navigator
 * (the thumbnails drawer on mobile) and the right rail with its tabs.
 */
export function useRailLayout(isMobile: boolean) {
  const showRail = useAppStore((s) => s.showRail);
  const setShowRail = useAppStore((s) => s.setShowRail);
  const railTab = useAppStore((s) => s.railTab);
  const setRailTab = useAppStore((s) => s.setRailTab);
  const showThumbs = useEditorStore((s) => s.showThumbs);
  const setShowThumbs = useEditorStore((s) => s.setShowThumbs);
  const showNavigator = useAppStore((s) => s.prefs.showNavigator);
  const setPrefs = useAppStore((s) => s.setPrefs);
  // Stable identity so the memoized RightRail doesn't re-render (or worse,
  // re-run its native-webview bounds work) every time App renders.
  const closeRail = useCallback(() => setShowRail(false), [setShowRail]);

  // Mobile editor defaults to "canvas full-bleed, both rails closed".
  // The store's default showThumbs is `true` for desktop ergonomics; on
  // a phone that would render the page list as a 320px overlay covering
  // most of the viewport before the user has done anything. Snap them
  // shut whenever the layout enters mobile mode (initial mount or via
  // window resize).
  useEffect(() => {
    if (isMobile) {
      setShowThumbs(false);
      setShowRail(false);
    }
  }, [isMobile, setShowRail, setShowThumbs]);

  useEffect(() => {
    if (
      (railTab === "terminal" && !CAPABILITIES.embeddedTerminal) ||
      (railTab === "browser" && !CAPABILITIES.embeddedBrowserPanel)
    ) {
      setRailTab("outline");
    }
  }, [railTab, setRailTab]);

  // Open and close the whole left gutter, keeping whichever view was last
  // shown — the icon rail is what picks a view. Mobile has no gutter and keeps
  // the standalone thumbnails drawer this button always opened.
  const toggleThumbsForLayout = useCallback(() => {
    if (isMobile) {
      if (!showThumbs) setShowRail(false);
      setShowThumbs(!showThumbs);
      return;
    }
    setPrefs({ showNavigator: !showNavigator });
  }, [isMobile, setPrefs, setShowRail, setShowThumbs, showNavigator, showThumbs]);

  const openRailTabForLayout = useCallback(
    (nextRailTab: RailTab) => {
      if (isMobile) setShowThumbs(false);
      if (!showRail) {
        setRailTab(nextRailTab);
        setShowRail(true);
        return;
      }
      if (railTab === nextRailTab) {
        setShowRail(false);
        return;
      }
      setRailTab(nextRailTab);
    },
    [isMobile, railTab, setRailTab, setShowRail, setShowThumbs, showRail],
  );

  // Mobile only: the outline is a right-rail tab there, because there is no
  // gutter for the icon rail. On desktop this button is not rendered.
  const toggleOutlineForLayout = useCallback(() => {
    openRailTabForLayout("outline");
  }, [openRailTabForLayout]);

  return {
    showRail,
    setShowRail,
    closeRail,
    showThumbs,
    setShowThumbs,
    showNavigator,
    toggleThumbsForLayout,
    openRailTabForLayout,
    toggleOutlineForLayout,
  };
}
