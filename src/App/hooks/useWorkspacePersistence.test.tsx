import "../../test/setupDom";
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "bun:test";
import { useEffect, useRef, useState } from "react";
import { loadWorkspaceState, type WorkspaceTabMeta } from "../../storage/workspace";
import { useWorkspacePersistence } from "./useWorkspacePersistence";

const baseTab: WorkspaceTabMeta = {
  id: "tab-a",
  kind: "markdown",
  title: "notes.md",
  size: 10,
  source: { type: "path", path: "/tmp/notes.md" },
  updatedAt: 1,
};

function Harness({ tabs }: { tabs: WorkspaceTabMeta[] }) {
  const ref = useRef(tabs);
  useEffect(() => {
    ref.current = tabs;
  }, [tabs]);
  const [getTabs] = useState(() => () => ref.current);
  useWorkspacePersistence({
    tabs,
    activeTabId: tabs[0]?.id ?? null,
    getTabs,
    toMeta: (tab) => tab,
    cacheIdsForTab: () => [],
    folderPaths: [],
  });
  return null;
}

describe("workspace persistence scheduling", () => {
  beforeEach(() => localStorage.clear());

  test("coalesces rapid tab updates into the latest metadata write", async () => {
    const view = render(<Harness tabs={[baseTab]} />);
    view.rerender(<Harness tabs={[{ ...baseTab, updatedAt: 2 }]} />);
    view.rerender(<Harness tabs={[{ ...baseTab, updatedAt: 3 }]} />);

    expect(loadWorkspaceState().tabs).toHaveLength(0);
    await act(() => Bun.sleep(300));
    expect(loadWorkspaceState().tabs[0]?.updatedAt).toBe(3);
  });

  test("flushes the latest metadata when the app unmounts", () => {
    const view = render(<Harness tabs={[{ ...baseTab, updatedAt: 9 }]} />);
    view.unmount();
    expect(loadWorkspaceState().tabs[0]?.updatedAt).toBe(9);
  });
});
