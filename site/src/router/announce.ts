import { useEffect, useRef } from "react";
import { useLang } from "../i18n/context";
import type { Route } from "./route";

// Hash routes remount the tree but used to leave document.title on the
// marketing string and focus on <body>. Screen-reader and keyboard
// users then heard the old page. Title always updates; focus moves
// only on an actual route change so the first paint does not yank it.
export function useRouteAnnouncement(route: Route) {
  const { t, lang } = useLang();
  const prev = useRef(route);

  useEffect(() => {
    const titles: Record<Route, string> = {
      marketing: t.documentTitleHome,
      changelog: t.documentTitleChangelog,
      shortcuts: t.documentTitleShortcuts,
      privacy: t.documentTitlePrivacy,
      support: t.documentTitleSupport,
    };
    document.title = titles[route];

    const changed = prev.current !== route;
    prev.current = route;
    if (!changed) return;

    const heading = document.querySelector("main h1");
    if (!(heading instanceof HTMLElement)) return;
    if (!heading.hasAttribute("tabindex")) heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }, [route, lang, t]);
}
