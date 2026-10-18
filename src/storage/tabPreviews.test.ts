import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import Dexie from "dexie";
import {
  IDBKeyRange as FakeIDBKeyRange,
  indexedDB as fakeIndexedDB,
} from "fake-indexeddb";

const globals = globalThis as typeof globalThis & {
  indexedDB: IDBFactory;
  IDBKeyRange: typeof IDBKeyRange;
};
globals.indexedDB = fakeIndexedDB as unknown as IDBFactory;
globals.IDBKeyRange = FakeIDBKeyRange as unknown as typeof IDBKeyRange;
Dexie.dependencies.indexedDB = fakeIndexedDB as unknown as IDBFactory;
Dexie.dependencies.IDBKeyRange = FakeIDBKeyRange as unknown as typeof IDBKeyRange;

describe("tab preview cache", () => {
  beforeEach(async () => {
    const { __workspaceTest } = await import("./workspace");
    const { __tabPreviewTest } = await import("./tabPreviews");
    await __workspaceTest.reset();
    __tabPreviewTest.setCapBytes(undefined);
  });

  afterEach(async () => {
    const { __tabPreviewTest } = await import("./tabPreviews");
    __tabPreviewTest.setCapBytes(undefined);
  });

  test("round-trips one last-view snapshot", async () => {
    const { putTabPreview, readTabPreview } = await import("./tabPreviews");
    expect(
      await putTabPreview({
        tabId: "paper",
        imageUrl: "data:image/jpeg;base64,preview",
        pageNumber: 12,
        scale: 1.25,
      }),
    ).toBe(true);
    expect(await readTabPreview("paper")).toMatchObject({
      pageNumber: 12,
      scale: 1.25,
      imageUrl: "data:image/jpeg;base64,preview",
    });
  });

  test("evicts the oldest derived preview at the global cap", async () => {
    const { __tabPreviewTest, putTabPreview, readTabPreview } = await import(
      "./tabPreviews"
    );
    __tabPreviewTest.setCapBytes(70);
    await putTabPreview({
      tabId: "old",
      imageUrl: `data:image/jpeg;base64,${"a".repeat(30)}`,
      pageNumber: 1,
      scale: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await putTabPreview({
      tabId: "new",
      imageUrl: `data:image/jpeg;base64,${"b".repeat(30)}`,
      pageNumber: 2,
      scale: 1,
    });
    expect(await readTabPreview("old")).toBeNull();
    expect(await readTabPreview("new")).not.toBeNull();
  });

  test("cleans previews whose tabs no longer exist", async () => {
    const { cleanupTabPreviews, putTabPreview, readTabPreview } = await import(
      "./tabPreviews"
    );
    for (const tabId of ["keep", "drop"]) {
      await putTabPreview({
        tabId,
        imageUrl: `data:image/jpeg;base64,${tabId}`,
        pageNumber: 1,
        scale: 1,
      });
    }
    await cleanupTabPreviews(new Set(["keep"]));
    expect(await readTabPreview("keep")).not.toBeNull();
    expect(await readTabPreview("drop")).toBeNull();
  });
});
