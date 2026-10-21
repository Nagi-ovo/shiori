import { draftContentHash, isHashOnlyDraftId } from "./draftIdentity";

/**
 * Drafts the LRU sweep must keep: those of documents open in workspace tabs,
 * resident or not, in this window or any other window of the same origin. A
 * tab that never suspended has no runtime-session copy, so evicting its draft
 * would reopen it after a restart without its edits. The workspace registers
 * the provider; storage cannot import the workspace.
 *
 * Every window shares one IndexedDB, so window B's quota sweep can reach the
 * drafts window A has open. Each window therefore publishes its open ids to
 * localStorage under its own session key, and checks the other windows' keys.
 * localStorage, not an IndexedDB table, because the sweep asks synchronously,
 * row by row. A window that crashes cannot remove its key, so entries carry a
 * heartbeat time and expire. The expiry is 20 beats: browsers throttle timers
 * in hidden tabs (Chrome to about once a minute), and a live but throttled
 * window must not lapse. A crashed window pins its drafts for at most that
 * long. A window publishes at once when it registers, whenever its set of
 * open drafts changes, and whenever the reader leaves it (blur, hidden).
 *
 * A frozen tab (Chrome, mobile browsers) runs no timers at all yet is still
 * open, so a lapsed heartbeat alone cannot tell it from a crash. Where Web
 * Locks exist, each registered window holds a lock named after its key until
 * it unregisters or dies, and an expired entry whose lock is held still
 * counts. Lock state is read asynchronously and cached at each publish; the
 * sweep asks synchronously. Until this window's first answer arrives, an
 * expired entry still counts (a window opened after another froze must not
 * take it for crashed), and expired entries are removed only after an answer.
 */

const KEY_PREFIX = "shiori:open-drafts:v1:";
const HEARTBEAT_MS = 15_000;
const EXPIRY_MS = 20 * HEARTBEAT_MS;

export type DraftProtectionDeps = {
  /** May throw (storage blocked) or return null (no storage). */
  storage: () => Storage | null;
  /** Wall-clock milliseconds: entries are compared across windows. */
  now: () => number;
  setTimeout: (run: () => void, ms: number) => number;
  clearTimeout: (handle: number) => void;
  /** Receives blur, visibilitychange, pagehide and pageshow. */
  target: EventTarget | null;
  sessionId: string;
  /** navigator.locks; null where absent (insecure origins), heartbeat only. */
  locks: Locks | null;
};

type Locks = {
  request(name: string, callback: () => Promise<void>): Promise<unknown>;
  query(): Promise<{ held?: { name?: string }[] }>;
};

type Entry = { at: number; ids: string[] };

function parseEntry(raw: string | null): Entry | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { at, ids } = value as Partial<Entry>;
    if (typeof at !== "number" || !Number.isFinite(at)) return null;
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) return null;
    return { at, ids };
  } catch {
    return null;
  }
}

export function createDraftProtection(deps: DraftProtectionDeps) {
  const ownKey = KEY_PREFIX + deps.sessionId;
  let openDraftIds: () => Iterable<string> = () => [];
  let registered = false;
  let timer: number | null = null;
  let releaseLock: (() => void) | null = null;
  // Keys whose window held its lock at the last query.
  let lockedKeys = new Set<string>();
  // Whether lockedKeys answers for anything yet; without Web Locks it never will.
  let locksKnown = deps.locks === null;

  function storage(): Storage | null {
    try {
      return deps.storage();
    } catch {
      return null;
    }
  }

  // Calls `visit` with every other window's key and its live entry (null when
  // expired or corrupt). Clock steps either way count as expiry.
  function otherEntries(visit: (key: string, entry: Entry | null) => void): void {
    const store = storage();
    if (!store) return;
    try {
      const keys: string[] = [];
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (key?.startsWith(KEY_PREFIX) && key !== ownKey) keys.push(key);
      }
      const now = deps.now();
      for (const key of keys) {
        const entry = parseEntry(store.getItem(key));
        const live =
          entry &&
          (Math.abs(now - entry.at) < EXPIRY_MS || !locksKnown || lockedKeys.has(key));
        visit(key, live ? entry : null);
      }
    } catch {
      // Storage went away mid-read: only this window's own drafts are known.
    }
  }

  function holdLock(): void {
    const locks = deps.locks;
    if (!locks || releaseLock) return;
    // Resolvable before the grant, so a stop() that wins the race still frees it.
    const held = new Promise<void>((resolve) => (releaseLock = resolve));
    try {
      locks.request(ownKey, () => held).catch(() => undefined);
    } catch {
      // No lock: this window is heartbeat-only for the others.
    }
  }

  // Re-reads lock state, then removes expired entries. A failed query keeps
  // the last answer; with none yet, the heartbeat alone decides from then on.
  function refreshLocksThenSweep(): void {
    const answered = () => {
      locksKnown = true;
      sweepExpired();
    };
    const locks = deps.locks;
    if (!locks) return sweepExpired();
    try {
      locks.query().then((snapshot) => {
        lockedKeys = new Set((snapshot.held ?? []).flatMap((lock) => lock.name ?? []));
        answered();
      }, answered);
    } catch {
      answered();
    }
  }

  function publish(): void {
    if (!registered) return;
    const store = storage();
    if (store) {
      try {
        store.setItem(ownKey, JSON.stringify({ at: deps.now(), ids: [...openDraftIds()] }));
      } catch {
        // Full or read-only storage: other windows fall back to their own tabs.
      }
    }
    refreshLocksThenSweep();
  }

  function sweepExpired(): void {
    const store = storage();
    if (!store) return;
    const expired: string[] = [];
    otherEntries((key, entry) => {
      if (!entry) expired.push(key);
    });
    try {
      for (const key of expired) store.removeItem(key);
    } catch {
      // Best effort; expired entries protect nothing either way.
    }
  }

  function withdraw(): void {
    try {
      storage()?.removeItem(ownKey);
    } catch {
      // An entry left behind expires on its own.
    }
  }

  function beat(): void {
    publish();
    timer = deps.setTimeout(beat, HEARTBEAT_MS);
  }

  const onPageHide = () => withdraw();

  function listen(on: boolean): void {
    const t = deps.target;
    if (!t) return;
    const method = on ? t.addEventListener.bind(t) : t.removeEventListener.bind(t);
    method("blur", publish);
    method("visibilitychange", publish);
    method("pageshow", publish);
    method("pagehide", onPageHide);
  }

  function stop(): void {
    if (timer !== null) deps.clearTimeout(timer);
    timer = null;
    if (registered) listen(false);
    registered = false;
    releaseLock?.();
    releaseLock = null;
    withdraw();
  }

  function anyOpen(match: (openId: string) => boolean): boolean {
    for (const openId of openDraftIds()) if (match(openId)) return true;
    let found = false;
    otherEntries((_key, entry) => {
      if (entry?.ids.some(match)) found = true;
    });
    return found;
  }

  return {
    protectOpenDrafts(provider: () => Iterable<string>): () => void {
      stop();
      openDraftIds = provider;
      registered = true;
      holdLock();
      listen(true);
      beat();
      return () => {
        if (openDraftIds !== provider) return;
        openDraftIds = () => [];
        stop();
      };
    },

    /** Publishes at once: call when the open set changes, as other windows'
     * sweeps may run before the next beat. */
    republishOpenDrafts: publish,

    /**
     * Whether the quota sweep must keep this row. A hash-only row is also
     * kept while a tab of the same bytes is open under its source's id: that
     * tab may still adopt it (claimDraft), and builds before source ids
     * published only the hash.
     */
    isDraftProtected(id: string): boolean {
      if (!isHashOnlyDraftId(id)) return anyOpen((openId) => openId === id);
      return anyOpen((openId) => draftContentHash(openId) === id);
    },

    /** Whether a tab in any window holds exactly this draft id. */
    isDraftOpen(id: string): boolean {
      return anyOpen((openId) => openId === id);
    },
  };
}

function newSessionId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  // randomUUID exists only in secure contexts (not plain http hosts).
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const shared = createDraftProtection({
  storage: () => (typeof localStorage === "undefined" ? null : localStorage),
  now: () => Date.now(),
  setTimeout: (run, ms) => globalThis.setTimeout(run, ms) as unknown as number,
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
  target: typeof window === "undefined" ? null : window,
  sessionId: newSessionId(),
  locks: (typeof navigator === "undefined" ? null : navigator.locks) ?? null,
});

export const protectOpenDrafts = shared.protectOpenDrafts;
export const isDraftProtected = shared.isDraftProtected;
export const isDraftOpen = shared.isDraftOpen;
export const republishOpenDrafts = shared.republishOpenDrafts;
