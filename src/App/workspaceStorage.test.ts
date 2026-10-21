import "../test/setupDom";
import { afterEach, describe, expect, test } from "bun:test";
import Dexie from "dexie";
import {
  IDBKeyRange as FakeIDBKeyRange,
  indexedDB as fakeIndexedDB,
} from "fake-indexeddb";

Dexie.dependencies.indexedDB = fakeIndexedDB as unknown as IDBFactory;
Dexie.dependencies.IDBKeyRange = FakeIDBKeyRange as unknown as typeof IDBKeyRange;
// Loaded after the fake is wired: Dexie binds its IndexedDB at construction.
const { __workspaceTest, getWorkspaceSource } = await import("../storage/workspace");
const { ensureWorkspaceSource, putReservedWorkspaceSource } = await import(
  "./workspaceStorage"
);
const { reservedWorkspaceSourceIds, WORKSPACE_SOURCE_KEY_PREFIX } = await import(
  "../storage/workspaceSourceReservations"
);
const { createDraftProtection } = await import("../storage/draftProtection");

const source = (name: string, savedAt: number) => ({
  kind: "markdown" as const,
  name,
  size: 20,
  bytes: new Uint8Array(20),
  savedAt,
});

describe("reserved workspace source writes", () => {
  afterEach(() => __workspaceTest.reset());

  // Two text working copies saving at once, together over the cap. One may be
  // refused, but a save that reports success must leave its row behind: the
  // tab points at it and reopens from it.
  test("a concurrent write's quota sweep never deletes a row another save reported", async () => {
    __workspaceTest.setSourceCapBytes(30);

    const results = await Promise.allSettled([
      putReservedWorkspaceSource(source("a.md", 2)),
      putReservedWorkspaceSource(source("b.md", 1)),
    ]);

    const saved = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    expect(saved.length).toBeGreaterThan(0);
    for (const id of saved) expect(await getWorkspaceSource(id)).toBeDefined();
  });

  // Window A's tab (or its still-opening drop) points at a row this window
  // never saw; this window's quota sweep must evict around it.
  test("a write's quota sweep keeps a row another window holds", async () => {
    const { putWorkspaceSource } = await import("../storage/workspace");
    const heldElsewhere = await putWorkspaceSource(source("a.md", 1));
    const windowA = createDraftProtection({
      storage: () => localStorage,
      now: Date.now,
      setTimeout: () => 0,
      clearTimeout: () => undefined,
      target: null,
      sessionId: "window-a",
      locks: null,
      keyPrefix: WORKSPACE_SOURCE_KEY_PREFIX,
    });
    const releaseA = windowA.protectOpenDrafts(() => [heldElsewhere]);
    try {
      __workspaceTest.setSourceCapBytes(30);
      await putReservedWorkspaceSource(source("b.md", 2)).catch(() => undefined);
      expect(await getWorkspaceSource(heldElsewhere)).toBeDefined();
    } finally {
      releaseA();
    }
  });

  // Its tab would only have appeared after the password, so nothing else
  // gives the dropped file's reserved row back.
  test("dismissing the password prompt of a dropped PDF gives up its cache row", async () => {
    const { makePasswordPromptRetryable } = await import("./tabLifecyclePorts");
    const input = await ensureWorkspaceSource({
      kind: "pdf",
      name: "locked.pdf",
      size: 4,
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    });
    const cacheId = input.cacheId!;

    makePasswordPromptRetryable({ input, options: {} });

    expect(reservedWorkspaceSourceIds()).not.toContain(cacheId);
    await Bun.sleep(0);
    expect(await getWorkspaceSource(cacheId)).toBeUndefined();
  });
});
