// Single source of platform detection used by Kbd (modifier translation)
// and Download (recommended-build badge). Two flavours:
//
// - getPlatformBase(): synchronous, module-load safe. Returns just the
//   coarse OS family. Used by Kbd which detects once and never updates.
// - usePlatform(): React hook. Starts from the sync base, then refines
//   the Mac arch (arm vs intel) via the UA-Client-Hints high-entropy
//   API on mount. Used by Download to pick the right recommendation.
//
// Default policy when the Mac arch can't be resolved: treat as
// Apple Silicon (M chip). That's the dominant Mac in 2026 and what the
// user expects when no other signal is available.

import { useEffect, useState } from "react";

export type PlatformBase =
  | "mac"
  | "windows"
  | "linux"
  | "android"
  | "ios"
  | "unknown";
export type Platform =
  | "mac-arm"
  | "mac-intel"
  | "mac"
  | "windows"
  | "linux"
  | "android"
  | "ios"
  | "unknown";

export function getPlatformBase(): PlatformBase {
  if (typeof navigator === "undefined") return "unknown";
  const haystack = (
    navigator.userAgent +
    " " +
    (navigator.platform || "")
  ).toLowerCase();
  // Order matters: mobile UAs often include "Linux" or "Mac OS X".
  // Keep iOS distinct for download recommendations; Kbd still renders
  // Apple shortcut glyphs for it.
  const touchAppleDesktop =
    /mac/.test(haystack) && (navigator.maxTouchPoints || 0) > 1;
  if (/win/.test(haystack)) return "windows";
  if (/android/.test(haystack)) return "android";
  if (/iphone|ipad|ipod/.test(haystack) || touchAppleDesktop) return "ios";
  if (/mac/.test(haystack)) return "mac";
  if (/linux|x11|cros/.test(haystack)) return "linux";
  return "unknown";
}

// Whether to render shortcuts with Apple glyphs (⌘ ⌥) rather than Ctrl/Alt.
//
// This must be a single shared predicate. Kbd got it right while Shortcuts.tsx
// compared `getPlatformBase() === "mac"` alone — but an iPad, or any Mac with
// a touchscreen, is classified "ios" above, so the same visitor saw ⌘ on the
// home page and "Ctrl" on the shortcuts page, which is the page the site
// invites them to print and pin up.
export function usesAppleKeys(): boolean {
  const base = getPlatformBase();
  return base === "mac" || base === "ios";
}

// UA-CH `architecture` is `"arm"` for Apple Silicon and `"x86"` for
// Intel. Available in Chromium-based browsers; Safari does not implement
// it. The hook silently keeps the coarse "mac" reading when the API is
// missing, which the consumer interprets as "default to M Chip".
type UADataLike = {
  getHighEntropyValues?: (
    hints: ReadonlyArray<string>,
  ) => Promise<{ architecture?: string }>;
};

export function usePlatform(): Platform {
  const [platform, setPlatform] = useState<Platform>(getPlatformBase);

  useEffect(() => {
    if (platform !== "mac") return;
    const uaData = (
      navigator as Navigator & { userAgentData?: UADataLike }
    ).userAgentData;
    if (!uaData?.getHighEntropyValues) return;
    let cancelled = false;
    uaData
      .getHighEntropyValues(["architecture"])
      .then((high) => {
        if (cancelled) return;
        if (high.architecture === "arm") setPlatform("mac-arm");
        else if (high.architecture === "x86") setPlatform("mac-intel");
      })
      .catch(() => {
        /* leave as "mac" — caller will treat as M Chip by default */
      });
    return () => {
      cancelled = true;
    };
  }, [platform]);

  return platform;
}
