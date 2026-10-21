import type { DocumentModel } from "../pdf/model/types";

const KEY_PREFIX = "shiori:oplog:v1:";

export type OperationLogEntry = {
  version: 1;
  id: string;
  model: DocumentModel;
  lastTouched: number;
};

// localStorage origin quota is ~5 MB and the op-log is only a fast second
// tier (IndexedDB autosave is primary). A model larger than this budget can't
// fit; blindly setItem-ing it just throws and silently disables recovery.
// Skip proactively instead, leaving headroom for other keys.
export const OPERATION_LOG_MAX_CHARS = 2_000_000;

export type OperationLogWriteResult =
  | "written"
  | "skipped-too-large"
  | "unavailable"
  | "error";

export function writeOperationLog(
  id: string,
  model: DocumentModel,
  now: number = Date.now(),
): OperationLogWriteResult {
  const storage = getStorage();
  if (!storage) return "unavailable";
  let serialized: string;
  try {
    const entry: OperationLogEntry = {
      version: 1,
      id,
      model,
      lastTouched: now,
    };
    serialized = JSON.stringify(entry);
  } catch {
    return "error";
  }
  // Too big to ever fit: skip the write but KEEP any existing entry. Recovery
  // (App.tsx) picks the newer of the op-log and the IndexedDB autosave by
  // timestamp, so a stale log is never restored over fresher work — but
  // dropping it here would throw away a snapshot that might still be the most
  // recent one, widening the crash-loss window. The caller flushes IndexedDB
  // immediately on a non-"written" result to close that gap.
  if (serialized.length > OPERATION_LOG_MAX_CHARS) {
    return "skipped-too-large";
  }
  try {
    storage.setItem(keyFor(id), serialized);
    return "written";
  } catch {
    // localStorage full/unavailable: keep the prior entry for the same reason.
    return "error";
  }
}

export function readOperationLog(id: string): OperationLogEntry | null {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(keyFor(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OperationLogEntry>;
    if (parsed.version !== 1 || parsed.id !== id || !parsed.model) return null;
    if (typeof parsed.lastTouched !== "number") return null;
    return parsed as OperationLogEntry;
  } catch {
    return null;
  }
}

export function clearOperationLog(id: string): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(keyFor(id));
  } catch {
    // ignore
  }
}

/** The ids of the readable logs whose id starts with `prefix`. */
export function operationLogIds(prefix: string): string[] {
  const storage = getStorage();
  if (!storage) return [];
  try {
    return operationLogKeys(storage)
      .map((key) => key.slice(KEY_PREFIX.length))
      .filter((id) => id.startsWith(prefix) && readOperationLog(id));
  } catch {
    return [];
  }
}

export function clearAllOperationLogs(): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    for (const key of operationLogKeys(storage)) {
      storage.removeItem(key);
    }
  } catch {
    // ignore
  }
}

// Startup housekeeping. Deliberately NOT "delete every log without a draft
// row": an op-log is written 250 ms after an edit and the IndexedDB draft only
// 800 ms after, so between those two a log with no draft row is the ONLY copy
// of the user's work — exactly the crash this second tier exists to survive.
// Treating "no draft row" as proof of staleness deleted that copy on the next
// launch, silently, which is the one moment it was needed. App.tsx already
// handles a log with no draft (`!draft`) on the recovery path.
//
// Age cannot distinguish the two cases either: a log written 500 ms before a
// crash looks a week old if the user comes back a week later.
//
// So orphans are kept newest-first under a bounded budget. Logs that belong to
// a live draft are always kept — they are cleared explicitly when the draft is
// deleted, evicted, or its recovery is resolved.
export const MAX_ORPHAN_OPERATION_LOGS = 8;
// localStorage is ~5 MB per origin and one log may be up to
// OPERATION_LOG_MAX_CHARS, so leave room for prefs and workspace keys.
export const MAX_ORPHAN_OPERATION_LOG_CHARS = 3_000_000;

export function pruneOperationLogs(activeIds: Set<string>): boolean {
  const storage = getStorage();
  if (!storage) return false;
  let changed = false;
  try {
    const orphans: Array<{ key: string; lastTouched: number; size: number }> =
      [];

    for (const key of operationLogKeys(storage)) {
      const id = key.slice(KEY_PREFIX.length);
      if (activeIds.has(id)) continue;
      const raw = storage.getItem(key);
      if (raw === null) continue;
      let lastTouched = 0;
      try {
        const parsed = JSON.parse(raw) as Partial<OperationLogEntry>;
        lastTouched =
          typeof parsed.lastTouched === "number" ? parsed.lastTouched : 0;
      } catch {
        // Unparseable: lastTouched 0 sorts it last, so it is dropped first.
      }
      orphans.push({ key, lastTouched, size: raw.length });
    }

    orphans.sort((a, b) => b.lastTouched - a.lastTouched);

    let kept = 0;
    let keptChars = 0;
    for (const orphan of orphans) {
      const withinCount = kept < MAX_ORPHAN_OPERATION_LOGS;
      const withinChars =
        keptChars + orphan.size <= MAX_ORPHAN_OPERATION_LOG_CHARS;
      if (orphan.lastTouched > 0 && withinCount && withinChars) {
        kept += 1;
        keptChars += orphan.size;
        continue;
      }
      storage.removeItem(orphan.key);
      changed = true;
    }
  } catch {
    // ignore
  }
  return changed;
}

function keyFor(id: string): string {
  return `${KEY_PREFIX}${id}`;
}

function operationLogKeys(storage: Storage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(KEY_PREFIX)) keys.push(key);
  }
  return keys;
}

function getStorage(): Storage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}
