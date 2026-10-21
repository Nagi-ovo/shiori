import "../../test/setupDom";
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "bun:test";
import Dexie from "dexie";
import {
  IDBKeyRange as FakeIDBKeyRange,
  indexedDB as fakeIndexedDB,
} from "fake-indexeddb";
import { useLayoutEffect, useRef, useState } from "react";
import type { WorkspaceTabMeta } from "../../storage/workspace";

Dexie.dependencies.indexedDB = fakeIndexedDB as unknown as IDBFactory;
Dexie.dependencies.IDBKeyRange = FakeIDBKeyRange as unknown as typeof IDBKeyRange;
// Loaded after the fake is wired: Dexie binds its IndexedDB at construction.
const { loadWorkspaceState } = await import("../../storage/workspace");
const { useWorkspacePersistence } = await import("./useWorkspacePersistence");
const { createDraftProtection } = await import("../../storage/draftProtection");
const { draftIdFor } = await import("../../storage/draftIdentity");
const { WORKSPACE_SOURCE_KEY_PREFIX } = await import(
  "../../storage/workspaceSourceReservations"
);

/** Another browser window of the app, publishing the cache rows it holds. */
function otherWindowSources(sessionId: string) {
  return createDraftProtection({
    storage: () => localStorage,
    now: Date.now,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    target: null,
    sessionId,
    locks: null,
    keyPrefix: WORKSPACE_SOURCE_KEY_PREFIX,
  });
}

const baseTab: WorkspaceTabMeta = {
  id: "tab-a",
  kind: "markdown",
  title: "notes.md",
  size: 10,
  source: { type: "path", path: "/tmp/notes.md" },
  updatedAt: 1,
};

function cacheIdsOf(tab: WorkspaceTabMeta): string[] {
  return tab.source.type === "cache" ? [tab.source.id] : [];
}

// Module-level, like App's mapper: a fresh function per render would re-register
// draft protection on every render and hide a missed republish.
const identityMeta = (tab: WorkspaceTabMeta) => tab;

function Harness({ tabs }: { tabs: WorkspaceTabMeta[] }) {
  const ref = useRef(tabs);
  // Current by the time the hook's layout effects run, like App's store read.
  useLayoutEffect(() => {
    ref.current = tabs;
  }, [tabs]);
  const [getTabs] = useState(() => () => ref.current);
  useWorkspacePersistence({
    tabs,
    activeTabId: tabs[0]?.id ?? null,
    getTabs,
    toMeta: identityMeta,
    cacheIdsForTab: cacheIdsOf,
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

  test("keeps the cache row of a document still opening when another tab arms the sweep", async () => {
    // A dropped or mobile-picked PDF gets its cache row before parsing; its
    // tab appears only once the open finishes (or a password is entered).
    const { getWorkspaceSource } = await import("../../storage/workspace");
    const { ensureWorkspaceSource } = await import("../workspaceStorage");
    const opening = await ensureWorkspaceSource({
      kind: "pdf",
      name: "second.pdf",
      size: 4,
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    });
    const cacheId = opening.cacheId!;
    const view = render(<Harness tabs={[baseTab]} />);
    await act(() => Bun.sleep(1100));
    expect(await getWorkspaceSource(cacheId)).toBeDefined();

    // Once the finished tab references the row, the reservation is spent:
    // closing that tab lets the next sweep reclaim it.
    const opened: WorkspaceTabMeta = {
      ...baseTab,
      id: "tab-b",
      kind: "pdf",
      title: "second.pdf",
      source: { type: "cache", id: cacheId },
    };
    view.rerender(<Harness tabs={[baseTab, opened]} />);
    await act(() => Bun.sleep(1100));
    view.rerender(<Harness tabs={[baseTab]} />);
    await act(() => Bun.sleep(1100));
    expect(await getWorkspaceSource(cacheId)).toBeUndefined();
    view.unmount();
  });

  test("keeps the cache row another window is still opening or has open", async () => {
    // Window A dropped an encrypted PDF and waits on its password prompt;
    // this window's sweep must not take the row A's tab will point at.
    const { getWorkspaceSource, putWorkspaceSource } = await import("../../storage/workspace");
    const pending = await putWorkspaceSource(
      { kind: "pdf", name: "locked.pdf", size: 4, bytes: new Uint8Array(4) },
      new Set(),
    );
    const windowA = otherWindowSources("window-a");
    const releaseA = windowA.protectOpenDrafts(() => [pending]);
    const view = render(<Harness tabs={[baseTab]} />);
    try {
      await act(() => Bun.sleep(1100));
      expect(await getWorkspaceSource(pending)).toBeDefined();

      // Once A closes, the next sweep here reclaims it.
      releaseA();
      // A tab-set change arms the next sweep.
      const another: WorkspaceTabMeta = {
        ...baseTab,
        id: "tab-c",
        source: { type: "cache", id: "another-row" },
      };
      view.rerender(<Harness tabs={[baseTab, another]} />);
      await act(() => Bun.sleep(1100));
      expect(await getWorkspaceSource(pending)).toBeUndefined();
    } finally {
      releaseA();
      view.unmount();
    }
  });

  test("the sweep keeps a row another window reserves while it runs", async () => {
    // The sweep deletes orphans, then evicts down to the cap. Window B's drop
    // lands in between; the eviction must see B's reservation.
    const { __workspaceTest, getWorkspaceSource, putWorkspaceSource } = await import(
      "../../storage/workspace"
    );
    const row = (id: string, savedAt: number) => ({
      id, kind: "pdf" as const, name: `${id}.pdf`, size: 20, bytes: new Uint8Array(20), savedAt,
    });
    await putWorkspaceSource(row("orphan-row", 1));
    await putWorkspaceSource(row("held-row", 3));
    __workspaceTest.setSourceCapBytes(30);
    let heldByB: string[] = [];
    const windowB = otherWindowSources("window-b");
    const closeB = windowB.protectOpenDrafts(() => heldByB);
    const { sources } = __workspaceTest.db;
    const bulkDelete = sources.bulkDelete;
    sources.bulkDelete = async (keys) => {
      await bulkDelete.call(sources, keys);
      heldByB = ["row-b"];
      windowB.republishOpenDrafts();
      await sources.put(row("row-b", 2));
    };
    const held: WorkspaceTabMeta = { ...baseTab, kind: "pdf", source: { type: "cache", id: "held-row" } };
    const view = render(<Harness tabs={[held]} />);
    try {
      await act(() => Bun.sleep(1100));
      expect(await getWorkspaceSource("orphan-row")).toBeUndefined();
      expect(await getWorkspaceSource("row-b")).toBeDefined();
    } finally {
      sources.bulkDelete = bulkDelete;
      __workspaceTest.setSourceCapBytes(undefined);
      closeB();
      view.unmount();
      await __workspaceTest.reset();
    }
  });

  test("this window's still-opening and open cache rows are protected in other windows", async () => {
    const { ensureWorkspaceSource } = await import("../workspaceStorage");
    const windowB = otherWindowSources("window-b");
    const cached: WorkspaceTabMeta = {
      ...baseTab,
      id: "tab-cached",
      kind: "pdf",
      source: { type: "cache", id: "cached-row" },
    };
    const view = render(<Harness tabs={[cached]} />);
    try {
      expect(windowB.otherWindowIds()).toContain("cached-row");
      const opening = await ensureWorkspaceSource({
        kind: "pdf",
        name: "dropped.pdf",
        size: 4,
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      });
      expect(windowB.otherWindowIds()).toContain(opening.cacheId!);
      view.rerender(<Harness tabs={[]} />);
      expect(windowB.otherWindowIds()).not.toContain("cached-row");
    } finally {
      view.unmount();
    }
  });

  test("never evicts the draft of a document open in a tab", async () => {
    // A tab that stays resident has no suspended-session copy: its draft is
    // the only durable record of its annotations across a restart.
    const { default: drafts, __draftsTest } = await import("../../storage/drafts");
    await __draftsTest.reset();
    const draft = (id: string, lastTouched: number) => ({
      id,
      fileName: `${id}.pdf`,
      fileSize: 1000,
      pdfBytes: new Uint8Array(1000),
      model: { pages: [], overlays: [] },
      lastTouched,
    });
    const openTab: WorkspaceTabMeta = {
      ...baseTab,
      id: "tab-pinned",
      kind: "pdf",
      title: "pinned.pdf",
      source: { type: "path", path: "/tmp/pinned.pdf" },
      hash: "pinned",
      pinned: true,
    };
    // A path tab's draft is keyed by its bytes and its path.
    const pinned = draftIdFor("pinned", openTab.source);
    const view = render(<Harness tabs={[openTab]} />);
    __draftsTest.setQuotaCapBytes(3500);
    try {
      await drafts.put(draft(pinned, 1));
      await drafts.put(draft("other-a", 2));
      await drafts.put(draft("other-b", 3));
      expect((await drafts.list()).map((row) => row.id).sort()).toEqual([
        "other-b",
        pinned,
      ]);

      // The startup sweep runs beside the restore; it must honour open tabs too.
      __draftsTest.setQuotaCapBytes(2000);
      await drafts.cleanup();
      expect((await drafts.list()).map((row) => row.id)).toEqual([pinned]);
    } finally {
      __draftsTest.setQuotaCapBytes(undefined);
      view.unmount();
      await __draftsTest.reset();
    }
  });

  test("a document opened in a tab is protected in other windows at once", () => {
    // Another window's autosave can run its quota sweep any moment after this
    // window opens an old annotated PDF, long before the next heartbeat.
    const otherWindow = createDraftProtection({
      storage: () => localStorage,
      now: Date.now,
      setTimeout: () => 0,
      clearTimeout: () => undefined,
      target: null,
      sessionId: "other-window",
      locks: null,
    });
    const view = render(<Harness tabs={[]} />);
    const fresh = draftIdFor("fresh", baseTab.source);
    try {
      view.rerender(<Harness tabs={[{ ...baseTab, kind: "pdf", hash: "fresh" }]} />);
      expect(otherWindow.isDraftProtected(fresh)).toBe(true);
      // It holds its own draft, not the bytes' hash-only one.
      expect(otherWindow.isDraftOpen("fresh")).toBe(false);
      view.rerender(<Harness tabs={[]} />);
      expect(otherWindow.isDraftProtected(fresh)).toBe(false);
    } finally {
      view.unmount();
    }
  });
});
