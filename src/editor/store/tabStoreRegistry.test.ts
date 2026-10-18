import { afterEach, describe, expect, test } from "bun:test";
import {
  clearTabEditorStores,
  ensureTabEditorStore,
  getTabEditorStore,
  leastRecentlyUsedTabEditorStore,
  removeTabEditorStore,
  residentTabEditorStoreCount,
  touchTabEditorStore,
} from "./tabStoreRegistry";

afterEach(() => clearTabEditorStores());

describe("tab editor store registry", () => {
  test("keeps one isolated store per tab id", () => {
    const first = ensureTabEditorStore("first");
    const second = ensureTabEditorStore("second");
    first.setState({ scale: 2 });

    expect(ensureTabEditorStore("first")).toBe(first);
    expect(second).not.toBe(first);
    expect(second.getState().scale).toBe(1);
  });

  test("removes only the requested tab", () => {
    const first = ensureTabEditorStore("first");
    ensureTabEditorStore("second");

    expect(removeTabEditorStore("first")).toBe(first);
    expect(getTabEditorStore("first")).toBeUndefined();
    expect(getTabEditorStore("second")).toBeDefined();
  });

  test("reports deterministic LRU order without exceeding the registry", () => {
    ensureTabEditorStore("oldest");
    ensureTabEditorStore("newest");
    touchTabEditorStore("oldest");

    expect(residentTabEditorStoreCount()).toBe(2);
    expect(leastRecentlyUsedTabEditorStore()?.tabId).toBe("newest");
    expect(
      leastRecentlyUsedTabEditorStore(new Set(["newest"]))?.tabId,
    ).toBe("oldest");
  });
});
