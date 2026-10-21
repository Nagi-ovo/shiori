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
const { putReservedWorkspaceSource } = await import("./workspaceStorage");

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
});
