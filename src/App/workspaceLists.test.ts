import "../test/setupDom";
import { describe, expect, test } from "bun:test";
import type { WorkspaceRuntimeTab } from "../workspace/types";
import { switcherItems, tabStripItems } from "./workspaceLists";

const tab = (id: string, kind: string, updatedAt: number, extra: Partial<WorkspaceRuntimeTab> = {}) =>
  ({
    id,
    kind,
    title: `${id}.${kind}`,
    size: 1,
    status: "loaded",
    source: { type: "path", path: `/d/${id}` },
    updatedAt,
    ...extra,
  }) as WorkspaceRuntimeTab;

describe("the Ctrl+Tab switcher", () => {
  // Comparative reading flips between two documents; one tap must go back.
  test("lists the document on screen first, then the most recently touched", () => {
    const tabs = [tab("a", "pdf", 1), tab("b", "markdown", 3), tab("c", "pdf", 2)];

    expect(switcherItems(tabs, "c").map((item) => item.id)).toEqual(["c", "b", "a"]);
  });
});

describe("the tab strip's unsaved marker", () => {
  test("a background PDF with unexported edits keeps its marker; the one on screen reads it live", () => {
    const tabs = [tab("shown", "pdf", 1), tab("behind", "pdf", 2)];
    const unexported = () => true;

    const items = tabStripItems(tabs, "shown", unexported);

    expect(items.map((item) => item.dirty)).toEqual([false, true]);
  });

  test("a text document is marked until its edits are written back to its file", () => {
    const tabs = [tab("a", "markdown", 1, { textDirty: true }), tab("b", "markdown", 2)];

    expect(tabStripItems(tabs, "a").map((item) => item.dirty)).toEqual([true, false]);
  });
});
