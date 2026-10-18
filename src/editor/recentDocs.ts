// Local-only MRU list of recently opened documents. Backed by a single
// localStorage key so it survives refreshes but never leaves the device.
// On Tauri we also stash the absolute path so clicking a row reopens the
// exact file. On web, browsers that support the File System Access API
// store a small IndexedDB handle separately and keep only its ID here.
// Entries with neither path nor webFileHandleId nor cacheId cannot be reopened.

import type { DocumentKind } from "../documents/types";

const KEY = "shiori:recent:v1";
const MAX = 8;

export type RecentEntry = {
  name: string;
  // PDF page count. 0 for Markdown/HTML, which have no page model — the
  // recent row shows the kind label instead of a page count for those.
  pages: number;
  size: number;
  savedAt: number;
  // Document kind. Absent on entries written before this field existed; treat
  // a missing value as "pdf" (the only kind recents used to record).
  kind?: DocumentKind;
  hash?: string;
  path?: string;
  webFileHandleId?: string;
  cacheId?: string;
  // JPEG data-URL of page 1 rendered at ~120 CSS px wide (2×). Captured
  // async after the PDF opens (see `attachRecentThumb`) so a fresh
  // entry lands in the list immediately and the thumbnail backfills.
  thumb?: string;
  // Short plain-text excerpt of a Markdown document, captured at record time.
  // The recents row renders it as a tiny Finder-style text thumbnail.
  textPreview?: string;
  // Capped raw HTML (scripts stripped) of an HTML document. The recents row
  // renders it in a scaled, sandboxed, remote-blocked iframe so the thumbnail
  // looks like the rendered page rather than its source text.
  htmlPreview?: string;
  // 0-based page index the user was on when they last navigated this
  // file. Restored on reopen so a long PDF resumes where the user left
  // off rather than snapping back to the cover.
  lastViewedPageIndex?: number;
};

export function recentEntryKey(
  entry: Pick<RecentEntry, "name" | "path" | "webFileHandleId" | "cacheId">,
): string {
  return entry.path ?? entry.webFileHandleId ?? entry.cacheId ?? entry.name;
}

export function canReopenRecent(
  entry: Pick<RecentEntry, "path" | "webFileHandleId" | "cacheId">,
  supportsNativePaths: boolean,
  supportsCachedSources: boolean = false,
): boolean {
  if (supportsNativePaths && entry.path) return true;
  if (!supportsNativePaths && entry.webFileHandleId) return true;
  return supportsCachedSources && Boolean(entry.cacheId);
}

export function recentMatchesFile(
  entry: Pick<RecentEntry, "name" | "size" | "hash">,
  file: Pick<RecentEntry, "name" | "size" | "hash">,
): boolean {
  if (entry.hash && file.hash) return entry.hash === file.hash;
  return entry.name === file.name && entry.size === file.size;
}

export function getRecent(): RecentEntry[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecentEntry);
  } catch {
    return [];
  }
}

export function recordRecent(entry: Omit<RecentEntry, "savedAt">): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    // Dedupe by the strongest reopen anchor we have: native path,
    // browser file handle ID, then legacy/pathless name.
    const key = recentEntryKey(entry);
    const existing = getRecent();
    const previous = existing.find((e) => recentEntryKey(e) === key);
    const deduped = existing.filter((e) => recentEntryKey(e) !== key);
    const next: RecentEntry[] = [
      {
        ...entry,
        savedAt: Date.now(),
        // Carry the prior reading position forward — recordRecent fires
        // on every reopen, but the user expects the page they were on
        // last time to survive the round-trip.
        lastViewedPageIndex:
          entry.lastViewedPageIndex ?? previous?.lastViewedPageIndex,
      },
      ...deduped,
    ].slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

/**
 * Persist the app-local PDF produced by a page merge as a real reopen anchor.
 *
 * The first merge keeps the original path/file-handle recent and adds a cached
 * working document beside it. Later merges replace that derived entry instead
 * of filling the eight-item MRU (and storage) with obsolete whole-PDF copies.
 */
export function recordMergedPdfRecent(
  entry: Omit<RecentEntry, "savedAt"> & { cacheId: string },
  previousCacheId?: string,
): boolean {
  const previous = previousCacheId
    ? getRecent().find((candidate) => candidate.cacheId === previousCacheId)
    : undefined;
  return previous ? replaceRecent(previous, entry) : recordRecent(entry);
}

export function replaceRecent(
  previous: RecentEntry,
  nextEntry: Omit<RecentEntry, "savedAt">,
): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    const previousKey = recentEntryKey(previous);
    const nextKey = recentEntryKey(nextEntry);
    const existing = getRecent();
    const priorForNext = existing.find((e) => recentEntryKey(e) === nextKey);
    const next: RecentEntry[] = [
      {
        ...nextEntry,
        savedAt: Date.now(),
        thumb: nextEntry.thumb ?? priorForNext?.thumb ?? previous.thumb,
        lastViewedPageIndex:
          nextEntry.lastViewedPageIndex ??
          priorForNext?.lastViewedPageIndex ??
          previous.lastViewedPageIndex,
      },
      ...existing.filter((e) => {
        const key = recentEntryKey(e);
        return key !== previousKey && key !== nextKey;
      }),
    ].slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

// Patch the lastViewedPageIndex on an existing entry without rewriting
// the rest of its fields. Caller is responsible for debouncing.
export function updateRecentLastPage(key: string, index: number): void {
  if (typeof localStorage === "undefined") return;
  try {
    const entries = getRecent();
    let changed = false;
    const next = entries.map((e) => {
      if (recentEntryKey(e) === key) {
        if (e.lastViewedPageIndex === index) return e;
        changed = true;
        return { ...e, lastViewedPageIndex: index };
      }
      return e;
    });
    if (changed) localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

// Look up the saved last-viewed page for a given recent-entry key.
// Returns undefined if no entry exists or the entry has never been
// navigated past page 0.
export function getRecentLastPage(key: string): number | undefined {
  const entry = getRecent().find((e) => recentEntryKey(e) === key);
  return entry?.lastViewedPageIndex;
}

export function hasRecentEntry(
  entry: Pick<RecentEntry, "name" | "path" | "webFileHandleId" | "cacheId">,
): boolean {
  const key = recentEntryKey(entry);
  return getRecent().some((e) => recentEntryKey(e) === key);
}

// Attach a captured thumbnail to an existing entry, identified by its
// localStorage key (path, web handle ID, or legacy name). No-ops if
// the entry has been LRU-evicted between `recordRecent` and the capture
// completing — the list is still consistent without it.
export function attachRecentThumb(key: string, thumb: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    const entries = getRecent();
    let changed = false;
    const next = entries.map((e) => {
      if (recentEntryKey(e) === key) {
        changed = true;
        return { ...e, thumb };
      }
      return e;
    });
    if (changed) localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // storage quota / privacy mode — drop silently
  }
}

// Remove a recent entry by its localStorage key. Called when we try to
// reopen via path/handle and the file is gone — no point keeping a dead
// pointer in the list.
export function forgetRecent(entry: RecentEntry): void {
  if (typeof localStorage === "undefined") return;
  try {
    const key = recentEntryKey(entry);
    const existing = getRecent();
    const next = existing.filter((e) => recentEntryKey(e) !== key);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

function isRecentEntry(v: unknown): v is RecentEntry {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.name === "string" &&
    typeof o.pages === "number" &&
    typeof o.size === "number" &&
    typeof o.savedAt === "number" &&
    (o.hash === undefined || typeof o.hash === "string") &&
    (o.path === undefined || typeof o.path === "string") &&
    (o.webFileHandleId === undefined ||
      typeof o.webFileHandleId === "string") &&
    (o.cacheId === undefined || typeof o.cacheId === "string") &&
    (o.thumb === undefined || typeof o.thumb === "string") &&
    (o.lastViewedPageIndex === undefined ||
      typeof o.lastViewedPageIndex === "number")
  );
}
