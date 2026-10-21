import "../test/setupDom";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import Dexie from "dexie";
import {
  IDBKeyRange as FakeIDBKeyRange,
  indexedDB as fakeIndexedDB,
} from "fake-indexeddb";
import type { DocumentModel } from "../pdf/model/types";

Dexie.dependencies.indexedDB = fakeIndexedDB as unknown as IDBFactory;
Dexie.dependencies.IDBKeyRange = FakeIDBKeyRange as unknown as typeof IDBKeyRange;

const { default: drafts, __draftsTest } = await import("./drafts");
const { claimDraft } = await import("./draftClaim");
const { draftIdFor, draftSource } = await import("./draftIdentity");
const { protectOpenDrafts } = await import("./draftProtection");
const { readOperationLog, writeOperationLog } = await import("./operationLog");

const HASH = "ab".repeat(32);
const atA = draftIdFor(HASH, { type: "path", path: "/docs/paper.pdf" });
const atB = draftIdFor(HASH, { type: "path", path: "/docs/paper copy.pdf" });

function model(label: string): DocumentModel {
  return {
    pages: [{ id: "p1", sourceIndex: 0, rotation: 0, widthPt: 100, heightPt: 100 }],
    overlays: [
      { type: "note", id: label, pageId: "p1", at: { x: 1, y: 1 }, text: label, color: "#ffd84d" },
    ],
  } as DocumentModel;
}

const save = (id: string, label: string, lastTouched = 10) =>
  drafts.put({
    id,
    fileName: "paper.pdf",
    fileSize: 4,
    pdfBytes: new Uint8Array([1, 2, 3, 4]),
    model: model(label),
    lastTouched,
  });

const noteOf = async (id: string) => {
  const draft = await drafts.get(id);
  return draft ? draft.model.overlays.map((overlay) => overlay.id) : null;
};

type ClaimLocks = NonNullable<Parameters<typeof claimDraft>[2]>["locks"];

/** navigator.locks for one origin: one holder per name, the rest wait in turn. */
function lockManager(): NonNullable<ClaimLocks> {
  const tails = new Map<string, Promise<unknown>>();
  return {
    request<T>(name: string, callback: () => Promise<T>): Promise<T> {
      const run = (tails.get(name) ?? Promise.resolve()).then(callback);
      tails.set(name, run.catch(() => undefined));
      return run;
    },
  };
}

let releases: (() => void)[] = [];
beforeEach(async () => {
  await __draftsTest.reset();
  localStorage.clear();
});
afterEach(async () => {
  for (const release of releases) release();
  releases = [];
  __draftsTest.setQuotaCapBytes(undefined);
  await __draftsTest.reset();
  localStorage.clear();
});

describe("draft identity", () => {
  test("durable sources get their own draft; cache and dropped bytes keep the hash", () => {
    expect(atA).not.toBe(atB);
    expect(draftIdFor(HASH, { type: "webFileHandle", id: "h1" })).not.toBe(HASH);
    expect(draftIdFor(HASH, { type: "cache", id: "c1" })).toBe(HASH);
    expect(draftIdFor(HASH, { type: "ephemeral" })).toBe(HASH);
    // Paths may contain anything, the separator included.
    const odd = { type: "path" as const, path: "/a|b/web:c.pdf" };
    expect(draftSource(draftIdFor(HASH, odd))).toEqual(odd);
    expect(draftSource(HASH)).toBeNull();
  });

  test("two same-byte paths keep separate drafts", async () => {
    await save(atA, "a");
    await save(atB, "b");
    expect(await claimDraft(HASH, atA)).toBe(atA);
    expect(await claimDraft(HASH, atB)).toBe(atB);
    expect(await noteOf(atA)).toEqual(["a"]);
    expect(await noteOf(atB)).toEqual(["b"]);
  });

  test("a hash-only draft from an older build is adopted once, unchanged", async () => {
    const written = await save(HASH, "legacy", 42);
    expect(await claimDraft(HASH, atA)).toBe(atA);
    const adopted = await drafts.get(atA);
    expect(adopted?.model.overlays.map((overlay) => overlay.id)).toEqual(["legacy"]);
    expect(Array.from(adopted?.pdfBytes ?? [])).toEqual([1, 2, 3, 4]);
    // The clean-baseline delete compares this version; it must still match.
    expect({ lastTouched: adopted?.lastTouched, revision: adopted?.revision }).toEqual(written);
    expect(await drafts.get(HASH)).toBeUndefined();
    expect(await __draftsTest.counts()).toEqual({ legacy: 0, blobs: 1, models: 1, receipts: 0 });

    // The same bytes at another path start clean.
    expect(await claimDraft(HASH, atB)).toBe(atB);
    expect(await drafts.get(atB)).toBeUndefined();
    expect(await noteOf(atA)).toEqual(["legacy"]);
  });

  test("a schema-v1 row is adopted with its bytes", async () => {
    await __draftsTest.putLegacyRow({
      id: HASH,
      fileName: "old.pdf",
      fileSize: 3,
      pdfBytes: new Uint8Array([7, 8, 9]),
      model: model("v1"),
      history: [],
      completedLiveOperationIds: [],
      createdAt: 1,
      lastTouched: 2,
    });
    await claimDraft(HASH, atA);
    expect(Array.from((await drafts.get(atA))?.pdfBytes ?? [])).toEqual([7, 8, 9]);
    expect(await drafts.get(HASH)).toBeUndefined();
  });

  test("an open tab still writing the hash-only draft keeps it, in any window", async () => {
    await save(HASH, "dropped");
    releases.push(protectOpenDrafts(() => [HASH]));
    expect(await claimDraft(HASH, atA)).toBe(atA);
    expect(await drafts.get(atA)).toBeUndefined();
    expect(await noteOf(HASH)).toEqual(["dropped"]);
  });

  test("the crash-recovery log moves with the draft, and alone", async () => {
    writeOperationLog(HASH, model("unsaved"), 77);
    await claimDraft(HASH, atA);
    expect(readOperationLog(HASH)).toBeNull();
    const moved = readOperationLog(atA);
    expect(moved?.lastTouched).toBe(77);
    expect(moved?.model.overlays.map((overlay) => overlay.id)).toEqual(["unsaved"]);

    // A source that already has a log keeps its own.
    writeOperationLog(HASH, model("other"), 88);
    await claimDraft(HASH, atA);
    expect(readOperationLog(atA)?.lastTouched).toBe(77);
  });

  test("a source whose only recovery is its crash log keeps it", async () => {
    // Path A crashed before its first autosave; a dropped copy saved later.
    writeOperationLog(atA, model("crash-in-a"), 100);
    await save(HASH, "dropped", 200);
    expect(await claimDraft(HASH, atA)).toBe(atA);
    expect(await drafts.get(atA)).toBeUndefined();
    expect(await noteOf(HASH)).toEqual(["dropped"]);
    expect(readOperationLog(atA)?.model.overlays.map((overlay) => overlay.id)).toEqual([
      "crash-in-a",
    ]);
  });

  test("two windows claiming the same old draft at once give it to one source", async () => {
    // Two windows open byte-identical files at different paths at the same moment.
    const both = async (locks: ClaimLocks | null) => {
      await save(HASH, "legacy", 10);
      writeOperationLog(HASH, model("unsaved"), 20);
      await Promise.all([claimDraft(HASH, atA, { locks }), claimDraft(HASH, atB, { locks })]);
      const owners = [atA, atB].filter((id) => readOperationLog(id) !== null);
      const withRows = [];
      for (const id of [atA, atB]) if (await drafts.get(id)) withRows.push(id);
      expect(owners).toHaveLength(1);
      expect(withRows).toEqual(owners);
      await __draftsTest.reset();
      localStorage.clear();
    };
    await both(lockManager());
    await both(null);
  });

  test("two windows claiming the same lone crash log at once give it to one source", async () => {
    writeOperationLog(HASH, model("unsaved"), 20);
    const locks = lockManager();
    await Promise.all([claimDraft(HASH, atA, { locks }), claimDraft(HASH, atB, { locks })]);
    expect([atA, atB].filter((id) => readOperationLog(id) !== null)).toHaveLength(1);
    expect(readOperationLog(HASH)).toBeNull();
  });

  test("a draft whose web file handle was forgotten can be claimed again", async () => {
    const oldHandle = draftIdFor(HASH, { type: "webFileHandle", id: "old" });
    const newHandle = draftIdFor(HASH, { type: "webFileHandle", id: "new" });
    await save(oldHandle, "web");
    const live = new Set(["old", "new"]);
    const deps = { webFileHandleExists: async (id: string) => live.has(id) };

    await claimDraft(HASH, newHandle, deps);
    expect(await drafts.get(newHandle)).toBeUndefined();

    live.delete("old");
    await claimDraft(HASH, newHandle, deps);
    expect(await noteOf(newHandle)).toEqual(["web"]);
    expect(await drafts.get(oldHandle)).toBeUndefined();
  });

  test("a crash log under a forgotten web file handle is claimed too", async () => {
    // The tab crashed before its first autosave, then its handle was pruned.
    const oldHandle = draftIdFor(HASH, { type: "webFileHandle", id: "old" });
    const newHandle = draftIdFor(HASH, { type: "webFileHandle", id: "new" });
    writeOperationLog(oldHandle, model("unsaved"), 77);
    const deps = { webFileHandleExists: async (id: string) => id === "new" };

    expect(await claimDraft(HASH, newHandle, deps)).toBe(newHandle);
    expect(readOperationLog(newHandle)?.model.overlays.map((overlay) => overlay.id)).toEqual([
      "unsaved",
    ]);
    expect(readOperationLog(oldHandle)).toBeNull();
  });

  test("a failed claim reads the unclaimed draft instead of opening clean", async () => {
    await save(HASH, "legacy");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const table = __draftsTest.db.table("draftModels");
    const refuse = () => {
      throw new DOMException("full", "QuotaExceededError");
    };
    table.hook("creating", refuse);
    try {
      expect(await claimDraft(HASH, atA)).toBe(HASH);
    } finally {
      table.hook("creating").unsubscribe(refuse);
      warn.mockRestore();
    }
    expect(await noteOf(HASH)).toEqual(["legacy"]);
    expect(await drafts.get(atA)).toBeUndefined();
  });

  test("a crash log that cannot move keeps the claim in place, rows and all", async () => {
    // The log is newer than the saved draft: the edits after the last autosave.
    await save(HASH, "saved", 10);
    writeOperationLog(HASH, model("newest"), 20);
    // localStorage has room for the log once, not for a second copy.
    const real = localStorage;
    const full: Storage = {
      get length() {
        return real.length;
      },
      key: (index) => real.key(index),
      getItem: (key) => real.getItem(key),
      removeItem: (key) => real.removeItem(key),
      clear: () => real.clear(),
      setItem: (key, value) => {
        if (key.endsWith(atA)) throw new DOMException("full", "QuotaExceededError");
        real.setItem(key, value);
      },
    };
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: full });
    let read: string;
    try {
      read = await claimDraft(HASH, atA);
    } finally {
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: real });
    }
    // Whatever id comes back holds both the rows and the newest edits.
    expect(await noteOf(read)).toEqual(["saved"]);
    expect(readOperationLog(read)?.model.overlays.map((overlay) => overlay.id)).toEqual([
      "newest",
    ]);
  });

  test("a failed row move leaves the crash log where the rows are", async () => {
    await save(HASH, "saved", 10);
    writeOperationLog(HASH, model("newest"), 20);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const table = __draftsTest.db.table("draftModels");
    const refuse = () => {
      throw new DOMException("full", "QuotaExceededError");
    };
    table.hook("creating", refuse);
    try {
      expect(await claimDraft(HASH, atA)).toBe(HASH);
    } finally {
      table.hook("creating").unsubscribe(refuse);
      warn.mockRestore();
    }
    expect(readOperationLog(HASH)?.lastTouched).toBe(20);
    expect(readOperationLog(atA)).toBeNull();
  });

  test("the quota sweep keeps an open tab's draft and the old row of its bytes", async () => {
    const OTHER = "cd".repeat(32);
    releases.push(protectOpenDrafts(() => [atA]));
    __draftsTest.setQuotaCapBytes(100_000);
    await save(HASH, "legacy", 1);
    await save(atA, "a", 2);
    await save(OTHER, "closed", 3);
    __draftsTest.setQuotaCapBytes(10);
    await drafts.cleanup();
    expect((await drafts.list()).map((row) => row.id).sort()).toEqual([atA, HASH].sort());
  });
});
