import { describe, expect, test } from "bun:test";
import { createWorkspaceStore } from "./workspaceStore";

const workspace = () =>
  createWorkspaceStore({ tabs: [], activeTabId: null, folderPaths: [] });

describe("navigation claims", () => {
  test("each document of a multi-select batch comes forward in turn", () => {
    const store = workspace();
    const batch = store.getState().claimForegroundIntent();

    const first = store.getState().claimOpen(batch);
    expect(first.ownsForeground()).toBe(true);
    const second = store.getState().claimOpen(batch);

    expect(first.ownsForeground()).toBe(false);
    expect(second.ownsForeground()).toBe(true);
  });

  test("a tab click ends the batch's right to the screen", () => {
    const store = workspace();
    const batch = store.getState().claimForegroundIntent();
    store.getState().claimOpen(batch);

    store.getState().claimNavigation();
    const late = store.getState().claimOpen(batch);

    expect(late.isCurrent()).toBe(true);
    expect(late.ownsForeground()).toBe(false);
  });
});
