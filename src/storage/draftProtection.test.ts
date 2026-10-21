import "../test/setupDom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createDraftProtection, protectOpenDrafts } from "./draftProtection";

/*
 * Ways cross-window draft protection can fail:
 * - window A has a document open; window B's quota sweep evicts its draft;
 * - A crashed (no pagehide) and its entry protects drafts forever;
 * - A is alive but hidden and throttled, and its entry lapses anyway;
 * - A is frozen (no timers at all, page still open) and is taken for crashed;
 * - A closed or went into the back/forward cache and still protects;
 * - A opened or closed a tab and B keeps the old set;
 * - storage is blocked, full or throws, and protection (or the app) breaks;
 * - a corrupt entry throws or is trusted.
 */

const HEARTBEAT_MS = 15_000;
const TTL_MS = 5 * 60_000;

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
    clear: () => map.clear(),
  };
}

/**
 * A clock for each window over one shared wall time, and one lock manager. A
 * crashed window's locks are gone; a frozen one keeps them but runs nothing.
 */
function world({ webLocks = true } = {}) {
  let now = 1_000_000;
  const storage = memoryStorage();
  const windows: ReturnType<typeof makeWindow>[] = [];
  const held = new Map<string, { crashed: boolean }>();
  function lockManager(owner: () => { crashed: boolean }) {
    return {
      request(name: string, callback: () => Promise<void>) {
        held.set(name, owner());
        return callback().finally(() => held.delete(name));
      },
      query: () =>
        Promise.resolve({
          held: [...held]
            .filter(([, win]) => !win.crashed)
            .map(([name]) => ({ name })),
        }),
    };
  }
  function makeWindow(sessionId: string) {
    const timers = new Map<number, { due: number; run: () => void }>();
    let next = 1;
    const target = new window.EventTarget();
    // A hidden, throttled tab runs its timers late: no sooner than this.
    const throttle = { minDelayMs: 0 };
    const protection = createDraftProtection({
      storage: () => storage,
      now: () => now,
      setTimeout: (run, ms) => {
        const handle = next++;
        timers.set(handle, { due: now + Math.max(ms, throttle.minDelayMs), run });
        return handle;
      },
      clearTimeout: (handle) => void timers.delete(handle),
      target,
      sessionId,
      locks: webLocks ? lockManager(() => win) : null,
    });
    const win = { protection, target, timers, throttle, crashed: false, frozen: false };
    windows.push(win);
    return win;
  }
  function advance(ms: number) {
    const until = now + ms;
    for (;;) {
      let due: { win: (typeof windows)[number]; handle: number; at: number } | null = null;
      for (const win of windows) {
        if (win.crashed || win.frozen) continue;
        for (const [handle, timer] of win.timers) {
          if (timer.due <= until && (!due || timer.due < due.at)) {
            due = { win, handle, at: timer.due };
          }
        }
      }
      if (!due) break;
      const timer = due.win.timers.get(due.handle)!;
      due.win.timers.delete(due.handle);
      now = due.at;
      timer.run();
    }
    now = until;
  }
  return { storage, makeWindow, advance, now: () => now };
}

/** Lets pending lock queries answer. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("draft protection across windows", () => {
  test("a draft open in another window is protected", () => {
    const w = world();
    const a = w.makeWindow("a");
    const b = w.makeWindow("b");
    a.protection.protectOpenDrafts(() => ["open-in-a"]);
    b.protection.protectOpenDrafts(() => ["open-in-b"]);

    expect(b.protection.isDraftProtected("open-in-a")).toBe(true);
    expect(a.protection.isDraftProtected("open-in-b")).toBe(true);
    expect(b.protection.isDraftProtected("closed")).toBe(false);
  });

  test("another window's path tab keeps the old hash-only row of its bytes", () => {
    const w = world();
    const a = w.makeWindow("a");
    const b = w.makeWindow("b");
    const hash = "ab".repeat(32);
    a.protection.protectOpenDrafts(() => [`${hash}|path:/docs/paper.pdf`]);
    b.protection.protectOpenDrafts(() => []);

    // The sweep keeps the row the tab may still adopt…
    expect(b.protection.isDraftProtected(hash)).toBe(true);
    expect(b.protection.isDraftProtected(`${hash}|path:/docs/copy.pdf`)).toBe(false);
    // …but no tab holds the hash-only draft itself, so a source may claim it.
    expect(b.protection.isDraftOpen(hash)).toBe(false);
    expect(b.protection.isDraftOpen(`${hash}|path:/docs/paper.pdf`)).toBe(true);
  });

  test("a live window stays protected long past the expiry, even throttled", () => {
    // Without Web Locks (plain http origins) the heartbeat alone has to hold.
    const w = world({ webLocks: false });
    const a = w.makeWindow("a");
    const b = w.makeWindow("b");
    a.throttle.minDelayMs = 60_000;
    a.protection.protectOpenDrafts(() => ["open-in-a"]);
    for (let i = 0; i < 6; i++) w.advance(TTL_MS);
    expect(b.protection.isDraftProtected("open-in-a")).toBe(true);
  });

  test("a crashed window stops protecting once its entry expires", async () => {
    const w = world();
    const a = w.makeWindow("a");
    const b = w.makeWindow("b");
    a.protection.protectOpenDrafts(() => ["open-in-a"]);
    b.protection.protectOpenDrafts(() => []);
    a.crashed = true;

    w.advance(TTL_MS - HEARTBEAT_MS);
    await settle();
    expect(b.protection.isDraftProtected("open-in-a")).toBe(true);
    w.advance(2 * HEARTBEAT_MS);
    await settle();
    expect(b.protection.isDraftProtected("open-in-a")).toBe(false);
  });

  test("a frozen window keeps its protection however long it sleeps", async () => {
    // Browsers freeze background tabs: no timers run, yet the page is open.
    const w = world();
    const a = w.makeWindow("a");
    const b = w.makeWindow("b");
    a.protection.protectOpenDrafts(() => ["open-in-a"]);
    b.protection.protectOpenDrafts(() => []);
    await settle();
    a.frozen = true;

    for (let i = 0; i < 6; i++) {
      w.advance(TTL_MS);
      await settle();
    }
    expect(b.protection.isDraftProtected("open-in-a")).toBe(true);
  });

  test("another window's sweep clears a crashed window's entry", () => {
    const w = world();
    const a = w.makeWindow("a");
    const b = w.makeWindow("b");
    a.protection.protectOpenDrafts(() => ["open-in-a"]);
    a.crashed = true;
    b.protection.protectOpenDrafts(() => []);
    const keysBefore = w.storage.length;

    w.advance(TTL_MS + HEARTBEAT_MS);
    expect(w.storage.length).toBe(keysBefore - 1);
  });

  test("closing a window drops its protection at once; back/forward restores it", () => {
    const w = world();
    const a = w.makeWindow("a");
    const b = w.makeWindow("b");
    a.protection.protectOpenDrafts(() => ["open-in-a"]);

    a.target.dispatchEvent(new Event("pagehide"));
    expect(b.protection.isDraftProtected("open-in-a")).toBe(false);
    a.target.dispatchEvent(new Event("pageshow"));
    expect(b.protection.isDraftProtected("open-in-a")).toBe(true);
  });

  test("unregistering stops protecting in every window", () => {
    const w = world();
    const a = w.makeWindow("a");
    const b = w.makeWindow("b");
    const release = a.protection.protectOpenDrafts(() => ["open-in-a"]);
    release();
    expect(a.protection.isDraftProtected("open-in-a")).toBe(false);
    expect(b.protection.isDraftProtected("open-in-a")).toBe(false);
    w.advance(TTL_MS);
    expect(b.protection.isDraftProtected("open-in-a")).toBe(false);
  });

  test("tab changes reach other windows on the next beat, or at once on leaving", () => {
    const w = world();
    const a = w.makeWindow("a");
    const b = w.makeWindow("b");
    let open = ["first"];
    a.protection.protectOpenDrafts(() => open);

    open = ["second"];
    w.advance(HEARTBEAT_MS);
    expect(b.protection.isDraftProtected("first")).toBe(false);
    expect(b.protection.isDraftProtected("second")).toBe(true);

    open = ["third"];
    a.target.dispatchEvent(new Event("blur"));
    expect(b.protection.isDraftProtected("third")).toBe(true);
    open = ["fourth"];
    a.target.dispatchEvent(new Event("visibilitychange"));
    expect(b.protection.isDraftProtected("fourth")).toBe(true);
  });

  test("blocked or full storage keeps same-window protection and never throws", () => {
    const blocked = createDraftProtection({
      storage: () => {
        throw new DOMException("denied", "SecurityError");
      },
      now: () => 0,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      target: new window.EventTarget(),
      sessionId: "blocked",
      locks: null,
    });
    const release = blocked.protectOpenDrafts(() => ["own"]);
    expect(blocked.isDraftProtected("own")).toBe(true);
    expect(blocked.isDraftProtected("other")).toBe(false);
    release();

    const full = memoryStorage();
    full.setItem = () => {
      throw new DOMException("full", "QuotaExceededError");
    };
    const cramped = createDraftProtection({
      storage: () => full,
      now: () => 0,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      target: new window.EventTarget(),
      sessionId: "cramped",
      locks: null,
    });
    cramped.protectOpenDrafts(() => ["own"]);
    expect(cramped.isDraftProtected("own")).toBe(true);
  });

  test("a corrupt entry protects nothing and is swept", () => {
    const w = world();
    const a = w.makeWindow("a");
    a.protection.protectOpenDrafts(() => ["open-in-a"]);
    const key = w.storage.key(0)!;
    const garbage = [
      "{",
      "null",
      '{"at":"x","ids":["open-in-a"]}',
      `{"at":${w.now()},"ids":"open-in-a"}`,
    ];
    for (const value of garbage) {
      a.crashed = true;
      w.storage.setItem(key, value);
      const b = w.makeWindow(`b-${value}`);
      expect(b.protection.isDraftProtected("open-in-a")).toBe(false);
    }
    const c = w.makeWindow("c");
    c.protection.protectOpenDrafts(() => []);
    expect(w.storage.getItem(key)).toBeNull();
  });
});

describe("draft eviction honours other windows", () => {
  let releaseOther: (() => void) | null = null;
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    releaseOther?.();
    releaseOther = null;
    localStorage.clear();
  });

  test("the quota sweep keeps a draft open only in another window", async () => {
    const { default: drafts, __draftsTest } = await import("./drafts");
    await __draftsTest.reset();
    const draft = (id: string, lastTouched: number) => ({
      id,
      fileName: `${id}.pdf`,
      fileSize: 1000,
      pdfBytes: new Uint8Array(1000),
      model: { pages: [], overlays: [] },
      lastTouched,
    });
    // This window has no tabs; the other window has `pinned` open.
    const releaseHere = protectOpenDrafts(() => []);
    const otherWindow = createDraftProtection({
      storage: () => localStorage,
      now: Date.now,
      setTimeout: (run, ms) => window.setTimeout(run, ms),
      clearTimeout: (handle) => window.clearTimeout(handle),
      target: new window.EventTarget(),
      sessionId: "other-window",
      locks: null,
    });
    releaseOther = otherWindow.protectOpenDrafts(() => ["pinned"]);
    __draftsTest.setQuotaCapBytes(3500);
    try {
      await drafts.put(draft("pinned", 1));
      await drafts.put(draft("other-a", 2));
      await drafts.put(draft("other-b", 3));
      expect((await drafts.list()).map((row) => row.id).sort()).toEqual([
        "other-b",
        "pinned",
      ]);

      __draftsTest.setQuotaCapBytes(2000);
      await drafts.cleanup();
      expect((await drafts.list()).map((row) => row.id)).toEqual(["pinned"]);

      // Once the other window closes, its draft is an ordinary LRU candidate.
      releaseOther();
      releaseOther = null;
      __draftsTest.setQuotaCapBytes(500);
      await drafts.cleanup();
      expect(await drafts.list()).toEqual([]);
    } finally {
      releaseHere();
      __draftsTest.setQuotaCapBytes(undefined);
      await __draftsTest.reset();
    }
  });
});
