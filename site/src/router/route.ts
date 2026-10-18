import { useEffect, useState } from "react";

// Hash-based routing keeps the site working on any static host (CF Pages,
// Vercel, plain S3) without configuring SPA fallback. The `#/` prefix
// keeps marketing-page anchors like `#features` / `#privacy` free — they
// still scroll inside PageScroller as before.

export type Route = "marketing" | "changelog" | "shortcuts" | "privacy" | "support";

export type ParsedHash = {
  route: Route;
  /** `#/changelog/<version>`: the release to land on, without a `v` prefix. */
  version: string | null;
};

const CHANGELOG_PREFIX = "#/changelog/";

/** Hash for a deep link to one release on the changelog page. */
export function changelogHref(version: string): string {
  return `${CHANGELOG_PREFIX}${version}`;
}

/** DOM id of a release's entry, `v26.9.27`, as the page labels it. Look it up
 *  with getElementById: as a CSS selector the dots would need escaping. */
export function releaseAnchorId(version: string): string {
  return `v${version}`;
}

// Pure so it can be tested without a DOM.
export function parseHash(hash: string): ParsedHash {
  if (hash === "#/changelog") return { route: "changelog", version: null };
  if (hash.startsWith(CHANGELOG_PREFIX)) {
    let segment = hash.slice(CHANGELOG_PREFIX.length).replace(/\/+$/, "");
    try {
      segment = decodeURIComponent(segment);
    } catch {
      // A malformed escape is just an unknown version.
    }
    // `#/changelog/v26.9.27` names the same release as `#/changelog/26.9.27`:
    // the page shows the version with a `v` tag in front of it.
    const version = segment.replace(/^v(?=\d)/i, "").trim();
    return { route: "changelog", version: version || null };
  }
  if (hash === "#/shortcuts") return { route: "shortcuts", version: null };
  if (hash === "#/privacy") return { route: "privacy", version: null };
  if (hash === "#/support") return { route: "support", version: null };
  return { route: "marketing", version: null };
}

function readHash(): ParsedHash {
  if (typeof window === "undefined") return { route: "marketing", version: null };
  return parseHash(window.location.hash);
}

function readRoute(): Route {
  return readHash().route;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(readRoute);
  useEffect(() => {
    const sync = () => setRoute(readRoute());
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  // Reset scroll on every route transition so users always start at the
  // top of the new page (covers mobile/reduced-motion where PageScroller
  // is bypassed and the marketing tree renders as a tall native stack).
  //
  // Except when the hash names a section rather than a route: `#download`
  // asked for a specific place on the marketing page, and pinning the scroll
  // to the top undid both the browser's own fragment scroll and
  // PageScroller's hash seeding. That left every Features/Specs/Download link
  // pressed from a doc page, and the /download/<platform> fallback redirect,
  // sitting silently on the hero.
  //
  // Likewise for `#/changelog/<version>`: <Changelog> scrolls to the release
  // (or to the top when it has no such release). Child effects run before
  // this one, so resetting here would undo that scroll.
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (hash && !hash.startsWith("/")) return;
    if (readHash().version) return;
    window.scrollTo(0, 0);
  }, [route]);
  return route;
}

/** The release named by `#/changelog/<version>`, tracked across in-page
 *  hash changes (pressing a version link does not change the route). */
export function useChangelogVersion(): string | null {
  const [version, setVersion] = useState<string | null>(() => readHash().version);
  useEffect(() => {
    const sync = () => setVersion(readHash().version);
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  return version;
}
