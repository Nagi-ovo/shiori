import { afterEach, describe, expect, test } from "bun:test";
import { reserveResidentPdfSlot } from "./residentPdfSessions";
import {
  clearTabEditorStores,
  ensureTabEditorStore,
  getTabEditorStore,
  removeTabEditorStore,
} from "./tabStoreRegistry";

afterEach(() => clearTabEditorStores());

describe("resident PDF admission", () => {
  test("does not evict while resident count is below the limit", async () => {
    ensureTabEditorStore("active");
    let suspends = 0;
    const result = await reserveResidentPdfSlot({
      targetTabId: "new",
      residentLimit: 2,
      activeTabId: "active",
      suspend: async () => {
        suspends += 1;
      },
    });
    expect(result).toEqual({ admitted: true, evictedTabId: null });
    expect(suspends).toBe(0);
  });

  test("waits for runtime destruction before releasing a full slot", async () => {
    ensureTabEditorStore("old");
    ensureTabEditorStore("active");
    let releaseDestroy = () => undefined;
    const destroySettled = new Promise<void>((resolve) => {
      releaseDestroy = resolve;
    });
    const admission = reserveResidentPdfSlot({
      targetTabId: "new",
      residentLimit: 2,
      activeTabId: "active",
      suspend: async (tabId) => {
        await destroySettled;
        removeTabEditorStore(tabId);
      },
    });
    await Promise.resolve();
    expect(getTabEditorStore("old")).toBeDefined();

    releaseDestroy();
    expect(await admission).toEqual({ admitted: true, evictedTabId: "old" });
    expect(getTabEditorStore("old")).toBeUndefined();
  });

  test("keeps the resident when snapshot persistence fails", async () => {
    ensureTabEditorStore("old");
    ensureTabEditorStore("active");
    const result = await reserveResidentPdfSlot({
      targetTabId: "new",
      residentLimit: 2,
      activeTabId: "active",
      suspend: async () => {
        throw new Error("quota");
      },
    });
    expect(result.admitted).toBe(false);
    expect(getTabEditorStore("old")).toBeDefined();
  });
});
