// Non-blocking record of drafts dropped by LRU eviction, kept in localStorage
// so Settings → Storage can tell the user what was cleared. Separate from the
// drafts themselves (IndexedDB); best-effort and never blocks eviction.
export type EvictionNotice = { fileName: string; evictedAt: number };

const EVICTIONS_KEY = "shiori:draft-evictions:v1";
const MAX_EVICTION_NOTICES = 20;

function evictionStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readEvictionNotices(storage: Storage): EvictionNotice[] {
  try {
    const raw = storage.getItem(EVICTIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (n): n is EvictionNotice =>
        !!n &&
        typeof (n as EvictionNotice).fileName === "string" &&
        typeof (n as EvictionNotice).evictedAt === "number",
    );
  } catch {
    return [];
  }
}

export function recordEvictions(fileNames: string[], now: number): void {
  const storage = evictionStorage();
  if (!storage) return;
  try {
    const next = [
      ...readEvictionNotices(storage),
      ...fileNames.map((fileName) => ({ fileName, evictedAt: now })),
    ].slice(-MAX_EVICTION_NOTICES);
    storage.setItem(EVICTIONS_KEY, JSON.stringify(next));
  } catch {
    // Best-effort: the notice is a courtesy, never block eviction on it.
  }
}

export function getEvictionNotices(): EvictionNotice[] {
  const storage = evictionStorage();
  return storage ? readEvictionNotices(storage) : [];
}

export function clearEvictionNotices(): void {
  const storage = evictionStorage();
  if (!storage) return;
  try {
    storage.removeItem(EVICTIONS_KEY);
  } catch {
    // ignore
  }
}
