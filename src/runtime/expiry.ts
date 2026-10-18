// Optional build-time expiry for closed beta builds. Vite's `define` pass
// replaces `__BUILD_TIMESTAMP__` and `__BUILD_EXPIRY_DAYS__` with literal
// values at compile time. Public builds inject 0 as the timestamp; `isExpired`
// treats that as "never expires".
//
// Desktop builds also enforce the same gate in Rust before native file
// open/read/save commands run. This module remains the web fallback and
// the source for the visible ExpiredScreen dates.

import { WEBSITE_URL } from "../shared/links";

declare const __BUILD_TIMESTAMP__: number;
declare const __BUILD_EXPIRY_DAYS__: number;

export const buildTimestamp = __BUILD_TIMESTAMP__;
export const expiryDays = __BUILD_EXPIRY_DAYS__;
export const expiryMs = expiryDays * 24 * 60 * 60 * 1000;

export const releaseUrl = `${WEBSITE_URL}/#download`;

export function buildDate(): Date | null {
  return buildTimestamp === 0 ? null : new Date(buildTimestamp);
}

export function expiresAt(): Date | null {
  return buildTimestamp === 0 || expiryDays === 0
    ? null
    : new Date(buildTimestamp + expiryMs);
}

export function isExpired(now: number = Date.now()): boolean {
  if (buildTimestamp === 0 || expiryDays === 0) return false;
  return now - buildTimestamp > expiryMs;
}
