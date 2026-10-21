import "../../test/setupDom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import Dexie from "dexie";
import {
  IDBKeyRange as FakeIDBKeyRange,
  indexedDB as fakeIndexedDB,
} from "fake-indexeddb";
import type { DocumentModel } from "../../pdf/model/types";
import type { WorkspaceRuntimeTab } from "../types";
import type { WorkspaceStore } from "../workspaceStore";
import { discardDraft, raiseDeferredDraft } from "../draftDecisions";
import type { ColdLoadPorts } from "./coldLoad";
import { bytes, fakePorts, workspace } from "./testing";

Dexie.dependencies.indexedDB = fakeIndexedDB as unknown as IDBFactory;
Dexie.dependencies.IDBKeyRange = FakeIDBKeyRange as unknown as typeof IDBKeyRange;

const { default: drafts, __draftsTest } = await import("../../storage/drafts");
const { claimDraft } = await import("../../storage/draftClaim");
const { draftIdFor } = await import("../../storage/draftIdentity");
const { readOperationLog } = await import("../../storage/operationLog");
const { sha256Hex } = await import("../../storage/hash");
const { coldLoadTab } = await import("./coldLoad");
const { openPdf } = await import("./openPdf");

/*
 * What a reader sees across sessions (storage-level cases live in
 * src/storage/draftIdentity.test.ts):
 * - the same bytes at two paths each restore their own draft after a restart;
 * - an older build's hash-only draft restores into the first path, once;
 * - a moved file finds the draft its dropped copy left, unless a tab of
 *   that copy is still open;
 * - a dropped (cache) source keeps reading and writing the bare hash;
 * - discarding a conflicting draft deletes that tab's draft, not the hash's.
 */

const PDF = bytes(1, 2, 3, 4);
const HASH = await sha256Hex(PDF);
const atA = draftIdFor(HASH, { type: "path", path: "/docs/paper.pdf" });
const atB = draftIdFor(HASH, { type: "path", path: "/docs/paper copy.pdf" });

function draftModel(note: string): DocumentModel {
  return {
    pages: [{ id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 }],
    overlays: [
      { type: "note", id: note, pageId: "p1", at: { x: 1, y: 1 }, text: note, color: "#ffd84d" },
    ],
  } as DocumentModel;
}

const saveDraft = (id: string, note: string) =>
  drafts.put({
    id,
    fileName: "paper.pdf",
    fileSize: 4,
    pdfBytes: PDF,
    model: draftModel(note),
    lastTouched: 10,
  });

function realDraftPorts(store: WorkspaceStore) {
  const base = fakePorts(store, {
    drafts: {
      claim: (hash, id) => claimDraft(hash, id),
      get: (id) => drafts.get(id),
      getLiveOperationReceipts: (hash) => drafts.getLiveOperationReceipts(hash),
      mergeLiveOperationReceipts: (hash, ids) => drafts.mergeLiveOperationReceipts(hash, ids),
      readOperationLog,
    },
  });
  return base;
}

const notesIn = (base: ReturnType<typeof realDraftPorts>, tabId: string) =>
  base.editors.get(tabId)?.getState().model.overlays.map((overlay) => overlay.id);

const openAt = async (store: WorkspaceStore, path?: string) => {
  const base = realDraftPorts(store);
  await openPdf({ name: "paper.pdf", size: 4, bytes: PDF, path }, {}, base.ports);
  const tab = store.getState().tabs.at(-1)!;
  return { tab, notes: notesIn(base, tab.id) };
};

beforeEach(async () => {
  await __draftsTest.reset();
  localStorage.clear();
});
afterEach(async () => {
  await __draftsTest.reset();
  localStorage.clear();
});

describe("draft identity through open and restart", () => {
  test("two same-byte paths keep separate drafts across a restart", async () => {
    await saveDraft(atA, "edited-in-a");
    await saveDraft(atB, "edited-in-b");
    const saved = (id: string, path: string) =>
      ({
        id,
        kind: "pdf",
        title: "paper.pdf",
        size: 4,
        status: "unloaded",
        source: { type: "path", path },
      }) as WorkspaceRuntimeTab;
    const store = workspace(
      [saved("a", "/docs/paper.pdf"), saved("b", "/docs/paper copy.pdf")],
      "a",
    );
    const base = realDraftPorts(store);
    const ports: ColdLoadPorts = {
      ...base.ports,
      // The tab's saved source supplies the path, as readTabSource does.
      readTabSource: async (tab) => ({
        payload: {
          kind: "pdf",
          name: "paper.pdf",
          size: 4,
          bytes: PDF,
          path: tab.source.type === "path" ? tab.source.path : undefined,
        },
      }),
      readRuntimeSession: async () => null,
      storageRepaired: async () => {},
      credential: () => undefined,
      reportRestoreFailed: () => {},
    };

    await coldLoadTab("a", ports);
    store.getState().setActiveTab("b");
    await coldLoadTab("b", ports);

    expect(notesIn(base, "a")).toEqual(["edited-in-a"]);
    expect(notesIn(base, "b")).toEqual(["edited-in-b"]);
  });

  test("an older build's hash-only draft restores into the first path only", async () => {
    await saveDraft(HASH, "from-older-build");
    const store = workspace();
    expect((await openAt(store, "/docs/paper.pdf")).notes).toEqual(["from-older-build"]);
    expect((await openAt(store, "/docs/paper copy.pdf")).notes).toEqual([]);

    // The same path in a later session finds it again.
    expect((await openAt(workspace(), "/docs/paper.pdf")).notes).toEqual(["from-older-build"]);
  });

  test("a moved file recovers the draft its dropped copy left", async () => {
    const store = workspace();
    const dropped = await openAt(store);
    expect(dropped.tab.source.type).toBe("cache");
    await saveDraft(HASH, "made-on-the-drop");

    // While the dropped tab is open it keeps its draft.
    const { protectOpenDrafts } = await import("../../storage/draftProtection");
    const release = protectOpenDrafts(() => [HASH]);
    try {
      expect((await openAt(workspace(), "/moved/paper.pdf")).notes).toEqual([]);
    } finally {
      release();
    }
    expect((await openAt(workspace(), "/moved/paper.pdf")).notes).toEqual(["made-on-the-drop"]);
  });

  test("a dropped copy keeps reading and writing the bare hash", async () => {
    await saveDraft(HASH, "dropped");
    expect((await openAt(workspace())).notes).toEqual(["dropped"]);
    expect(await drafts.get(HASH)).toBeTruthy();
  });

  test("discarding a conflicting draft deletes that tab's draft", async () => {
    await saveDraft(atA, "a");
    await saveDraft(atB, "b");
    const store = workspace();
    const base = realDraftPorts(store);
    await openPdf(
      { name: "paper.pdf", size: 4, bytes: PDF, path: "/docs/paper copy.pdf" },
      {},
      base.ports,
    );
    const { restoredDraft } = store.getState().session;
    raiseDeferredDraft(store, restoredDraft!.draft);
    const removed: string[] = [];
    discardDraft({
      store,
      editor: () => base.editors.get(store.getState().activeTabId!)!,
      removeDraft: (id) => removed.push(id),
    });
    expect(removed).toEqual([atB]);
  });
});
