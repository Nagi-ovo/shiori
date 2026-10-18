import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  canReopenRecent,
  forgetRecent,
  getRecent,
  getRecentLastPage,
  hasRecentEntry,
  recentMatchesFile,
  recentEntryKey,
  recordMergedPdfRecent,
  recordRecent,
  replaceRecent,
  updateRecentLastPage,
} from "./recentDocs";

class MemoryStorage implements Storage {
  private readonly data = new Map<string, string>();
  get length(): number {
    return this.data.size;
  }
  clear(): void {
    this.data.clear();
  }
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

class FailingStorage extends MemoryStorage {
  override setItem(): void {
    throw new Error("quota exceeded");
  }
}

describe("recentDocs lastViewedPageIndex", () => {
  let original: Storage | undefined;

  beforeEach(() => {
    original = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: new MemoryStorage(),
    });
  });

  afterEach(() => {
    if (original) {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: original,
      });
    }
  });

  test("getRecentLastPage returns undefined for missing entries", () => {
    expect(getRecentLastPage("/missing.pdf")).toBeUndefined();
  });

  test("updateRecentLastPage writes to an existing entry", () => {
    recordRecent({ name: "doc.pdf", pages: 80, size: 1000, path: "/a/doc.pdf" });
    updateRecentLastPage("/a/doc.pdf", 42);
    expect(getRecentLastPage("/a/doc.pdf")).toBe(42);
  });

  test("updateRecentLastPage no-ops when entry does not exist", () => {
    updateRecentLastPage("/never-recorded.pdf", 5);
    expect(getRecentLastPage("/never-recorded.pdf")).toBeUndefined();
    expect(getRecent()).toEqual([]);
  });

  test("recordRecent carries forward the previous lastViewedPageIndex on re-open", () => {
    recordRecent({ name: "x.pdf", pages: 100, size: 5000, path: "/x.pdf" });
    updateRecentLastPage("/x.pdf", 73);
    // Simulate the user reopening the same file later — recordRecent
    // fires again with no explicit lastViewedPageIndex, but the prior
    // reading position must survive the round-trip.
    recordRecent({ name: "x.pdf", pages: 100, size: 5000, path: "/x.pdf" });
    expect(getRecentLastPage("/x.pdf")).toBe(73);
  });

  test("recordRecent reports when the reopen anchor could not be stored", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: new FailingStorage(),
    });

    expect(
      recordRecent({
        name: "draft.md",
        pages: 0,
        size: 12,
        kind: "markdown",
        cacheId: "working-draft",
      }),
    ).toBe(false);
  });

  test("a closed merged PDF remains a reopenable Landing recent", () => {
    recordRecent({
      name: "paper.pdf",
      pages: 10,
      size: 100,
      hash: "original",
      path: "/papers/paper.pdf",
    });

    expect(
      recordMergedPdfRecent({
        name: "paper.pdf",
        pages: 12,
        size: 120,
        hash: "merged-1",
        cacheId: "merged-cache-1",
      }),
    ).toBe(true);

    // Closing removes the tab, not recents. Landing can therefore reopen the
    // exact merged hash instead of opening the original and missing its draft.
    const merged = getRecent().find((entry) => entry.hash === "merged-1");
    expect(merged?.cacheId).toBe("merged-cache-1");
    expect(canReopenRecent(merged ?? {}, false, true)).toBe(true);
    expect(getRecent().some((entry) => entry.path === "/papers/paper.pdf")).toBe(
      true,
    );

    // A second merge advances the derived anchor instead of retaining every
    // obsolete whole-PDF cache in the eight-item MRU.
    expect(
      recordMergedPdfRecent(
        {
          name: "paper.pdf",
          pages: 13,
          size: 130,
          hash: "merged-2",
          cacheId: "merged-cache-2",
        },
        "merged-cache-1",
      ),
    ).toBe(true);
    expect(getRecent().some((entry) => entry.cacheId === "merged-cache-1")).toBe(
      false,
    );
    expect(getRecent().some((entry) => entry.cacheId === "merged-cache-2")).toBe(
      true,
    );
  });

  test("recordRecent without a path falls back to name as the key", () => {
    recordRecent({ name: "drag-drop.pdf", pages: 50, size: 100 });
    updateRecentLastPage("drag-drop.pdf", 11);
    expect(getRecentLastPage("drag-drop.pdf")).toBe(11);
    recordRecent({ name: "drag-drop.pdf", pages: 50, size: 100 });
    expect(getRecentLastPage("drag-drop.pdf")).toBe(11);
  });

  test("recordRecent uses a web file handle id before falling back to name", () => {
    recordRecent({
      name: "web.pdf",
      pages: 50,
      size: 100,
      webFileHandleId: "handle-1",
    });
    updateRecentLastPage("handle-1", 11);
    expect(getRecentLastPage("handle-1")).toBe(11);

    recordRecent({
      name: "web.pdf",
      pages: 52,
      size: 120,
      webFileHandleId: "handle-1",
    });

    expect(getRecent()).toHaveLength(1);
    expect(getRecent()[0]?.pages).toBe(52);
    expect(getRecentLastPage("handle-1")).toBe(11);
  });

  test("recentEntryKey prefers path, then web handle, then name", () => {
    expect(
      recentEntryKey({
        name: "x.pdf",
        path: "/x.pdf",
        webFileHandleId: "handle-x",
        cacheId: "cache-x",
      }),
    ).toBe("/x.pdf");
    expect(
      recentEntryKey({
        name: "x.pdf",
        webFileHandleId: "handle-x",
        cacheId: "cache-x",
      }),
    ).toBe("handle-x");
    expect(recentEntryKey({ name: "x.pdf", cacheId: "cache-x" })).toBe(
      "cache-x",
    );
    expect(recentEntryKey({ name: "x.pdf" })).toBe("x.pdf");
  });

  test("canReopenRecent matches the current platform anchor", () => {
    expect(canReopenRecent({ path: "/x.pdf" }, true)).toBe(true);
    expect(canReopenRecent({ webFileHandleId: "handle-x" }, false)).toBe(true);
    expect(canReopenRecent({ cacheId: "cache-x" }, false, true)).toBe(true);
    expect(canReopenRecent({ webFileHandleId: "handle-x" }, true)).toBe(false);
    expect(canReopenRecent({ path: "/x.pdf" }, false)).toBe(false);
    expect(canReopenRecent({ cacheId: "cache-x" }, false)).toBe(false);
    expect(canReopenRecent({}, false)).toBe(false);
  });

  test("recentMatchesFile prefers hashes and falls back to name plus size", () => {
    expect(
      recentMatchesFile(
        { name: "same.pdf", size: 100, hash: "hash-a" },
        { name: "renamed.pdf", size: 100, hash: "hash-a" },
      ),
    ).toBe(true);
    expect(
      recentMatchesFile(
        { name: "same.pdf", size: 100, hash: "hash-a" },
        { name: "same.pdf", size: 100, hash: "hash-b" },
      ),
    ).toBe(false);
    expect(
      recentMatchesFile(
        { name: "legacy.pdf", size: 100 },
        { name: "legacy.pdf", size: 100, hash: "hash-c" },
      ),
    ).toBe(true);
    expect(
      recentMatchesFile(
        { name: "legacy.pdf", size: 100 },
        { name: "other.pdf", size: 100 },
      ),
    ).toBe(false);
  });

  test("explicit lastViewedPageIndex on recordRecent overrides the stored value", () => {
    recordRecent({ name: "y.pdf", pages: 100, size: 100, path: "/y.pdf" });
    updateRecentLastPage("/y.pdf", 25);
    recordRecent({
      name: "y.pdf",
      pages: 100,
      size: 100,
      path: "/y.pdf",
      lastViewedPageIndex: 0,
    });
    expect(getRecentLastPage("/y.pdf")).toBe(0);
  });

  test("forgetRecent removes the entry and its saved page", () => {
    recordRecent({ name: "z.pdf", pages: 30, size: 100, path: "/z.pdf" });
    updateRecentLastPage("/z.pdf", 14);
    expect(getRecentLastPage("/z.pdf")).toBe(14);
    const entry = getRecent().find((e) => e.path === "/z.pdf");
    if (!entry) throw new Error("entry expected to exist after recordRecent");
    forgetRecent(entry);
    expect(getRecentLastPage("/z.pdf")).toBeUndefined();
  });

  test("hasRecentEntry checks by the same key used for removal", () => {
    recordRecent({
      name: "web.pdf",
      pages: 30,
      size: 100,
      webFileHandleId: "handle-web",
    });

    expect(
      hasRecentEntry({ name: "web.pdf", webFileHandleId: "handle-web" }),
    ).toBe(true);
    expect(hasRecentEntry({ name: "web.pdf", path: "/missing.pdf" })).toBe(
      false,
    );
  });

  test("replaceRecent re-anchors a stale web handle without duplicating it", () => {
    recordRecent({
      name: "web.pdf",
      pages: 30,
      size: 100,
      webFileHandleId: "old-handle",
      thumb: "data:image/jpeg;base64,old",
    });
    updateRecentLastPage("old-handle", 12);
    const previous = getRecent()[0];
    if (!previous) throw new Error("previous recent entry expected");

    replaceRecent(previous, {
      name: "web.pdf",
      pages: 31,
      size: 120,
      hash: "hash-new",
      webFileHandleId: "new-handle",
    });

    const list = getRecent();
    expect(list).toHaveLength(1);
    expect(recentEntryKey(list[0]!)).toBe("new-handle");
    expect(list[0]?.pages).toBe(31);
    expect(list[0]?.hash).toBe("hash-new");
    expect(list[0]?.thumb).toBe("data:image/jpeg;base64,old");
    expect(getRecentLastPage("new-handle")).toBe(12);
    expect(getRecentLastPage("old-handle")).toBeUndefined();
  });

  test("isRecentEntry tolerates legacy entries without lastViewedPageIndex", () => {
    // Hand-write a v1-style entry into localStorage.
    localStorage.setItem(
      "shiori:recent:v1",
      JSON.stringify([
        { name: "old.pdf", pages: 10, size: 100, savedAt: 1, path: "/old.pdf" },
      ]),
    );
    const list = getRecent();
    expect(list.length).toBe(1);
    expect(list[0]?.lastViewedPageIndex).toBeUndefined();
    // Updating a legacy entry still works.
    updateRecentLastPage("/old.pdf", 3);
    expect(getRecentLastPage("/old.pdf")).toBe(3);
  });
});
