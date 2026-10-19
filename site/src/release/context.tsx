/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

// Mirror of the `Platform` enum in functions/_release.ts. Kept inline to
// avoid pulling worker types into the React tsconfig.
export type ReleasePlatform =
  | "mac-silicon"
  | "mac-intel"
  | "windows"
  | "linux-appimage"
  | "linux-deb"
  | "android";

export interface PlatformInfo {
  filename: string;
  size: number;
  url: string;
}

export interface ReleaseInfo {
  version: string;
  publishedAt: string;
  platforms: Partial<Record<ReleasePlatform, PlatformInfo>>;
}

// Mirror of DownloadTotals in functions/_release.ts.
export interface DownloadsInfo {
  total: number;
  byPlatform: Record<"macos" | "windows" | "linux" | "android", number>;
  releases: number;
  generatedAt: string;
}

const ReleaseContext = createContext<ReleaseInfo | null>(null);
const DownloadsContext = createContext<DownloadsInfo | null>(null);

// Fetches /api/release once when the app mounts and shares the result
// with every component below. Keeps the homepage's download card and
// spec strip pointing at the same numbers without firing the GitHub-
// API edge function twice. Stays null while the request is in flight
// or if it fails — consumers fall back to whatever placeholder copy
// they had before they knew about a release.
export function ReleaseProvider({ children }: { children: ReactNode }) {
  const [release, setRelease] = useState<ReleaseInfo | null>(null);
  const [downloads, setDownloads] = useState<DownloadsInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    // The page links the APK directly, so it can take the repo's current
    // path; the bare route keeps the old one for installed Android builds.
    fetch("/api/release?apkRepo=shiori")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: ReleaseInfo | null) => {
        if (!cancelled && data) setRelease(data);
      })
      .catch(() => {
        // Silent. Consumers see `null` and render their static fallback.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Separate route, separate edge cache, separate failure: a stalled or
  // 502'd download total must not keep the version and file sizes off
  // the page.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/downloads")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: DownloadsInfo | null) => {
        if (!cancelled && data) setDownloads(data);
      })
      .catch(() => {
        // Silent. The download card simply omits the count.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <ReleaseContext.Provider value={release}>
      <DownloadsContext.Provider value={downloads}>
        {children}
      </DownloadsContext.Provider>
    </ReleaseContext.Provider>
  );
}

export function useRelease(): ReleaseInfo | null {
  return useContext(ReleaseContext);
}

export function useDownloads(): DownloadsInfo | null {
  return useContext(DownloadsContext);
}
