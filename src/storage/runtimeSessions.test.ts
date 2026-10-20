import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import Dexie from "dexie";
import {
  IDBKeyRange as FakeIDBKeyRange,
  indexedDB as fakeIndexedDB,
} from "fake-indexeddb";
import type { PageModel } from "../pdf/model/types";

const globals = globalThis as typeof globalThis & {
  indexedDB: IDBFactory;
  IDBKeyRange: typeof IDBKeyRange;
};
globals.indexedDB = fakeIndexedDB as unknown as IDBFactory;
globals.IDBKeyRange = FakeIDBKeyRange as unknown as typeof IDBKeyRange;
Dexie.dependencies.indexedDB = fakeIndexedDB as unknown as IDBFactory;
Dexie.dependencies.IDBKeyRange = FakeIDBKeyRange as unknown as typeof IDBKeyRange;

const page: PageModel = {
  id: "page-a",
  sourceIndex: 0,
  rotation: 0,
  widthPt: 612,
  heightPt: 792,
};

describe("suspended PDF runtime sessions", () => {
  beforeEach(async () => {
    const { __workspaceTest } = await import("./workspace");
    const { __runtimeSessionTest } = await import("./runtimeSessions");
    await __workspaceTest.reset();
    __runtimeSessionTest.setCapBytes(undefined);
    __runtimeSessionTest.setBeforeWrite(null);
    __runtimeSessionTest.clearCredentials();
  });

  afterEach(async () => {
    const { __runtimeSessionTest } = await import("./runtimeSessions");
    __runtimeSessionTest.setCapBytes(undefined);
    __runtimeSessionTest.setBeforeWrite(null);
    __runtimeSessionTest.clearCredentials();
  });

  test("counts storage without deserializing suspended PDF bytes", async () => {
    const { workspaceDb } = await import("./workspace");
    const { runtimeSessionStorageBytes } = await import("./runtimeSessions");
    await workspaceDb.runtimePdfBlobs.bulkPut([
      { hash: "a", size: 3, bytes: new Uint8Array([1, 2, 3]), refCount: 1 },
      { hash: "b", size: 2, bytes: new Uint8Array([4, 5]), refCount: 2 },
    ]);
    let reads = 0;
    const onRead = (row: unknown) => { reads++; return row; };
    workspaceDb.runtimePdfBlobs.hook("reading", onRead);
    try {
      expect(await runtimeSessionStorageBytes()).toBe(5);
      expect(reads).toBe(0);
    } finally {
      workspaceDb.runtimePdfBlobs.hook("reading").unsubscribe(onRead);
    }
  });

  test("quota checks do not read unrelated suspended PDFs", async () => {
    const { workspaceDb } = await import("./workspace");
    const { createPdfEditorStore } = await import("../editor/store/store");
    const { captureSuspendedPdfSnapshot, putRuntimeSession } = await import("./runtimeSessions");
    const snapshot = captureSuspendedPdfSnapshot(createPdfEditorStore());
    const old = await putRuntimeSession({ tabId: "old", bytes: new Uint8Array([1, 2, 3]), snapshot });
    let unrelatedReads = 0;
    const onRead = (row: { hash: string } | undefined) => {
      if (row?.hash === old.blobHash) unrelatedReads++;
      return row;
    };
    workspaceDb.runtimePdfBlobs.hook("reading", onRead);
    try {
      await putRuntimeSession({ tabId: "new", bytes: new Uint8Array([4, 5, 6]), snapshot });
      expect(unrelatedReads).toBe(0);
    } finally {
      workspaceDb.runtimePdfBlobs.hook("reading").unsubscribe(onRead);
    }
  });

  test("upgrading a v5 workspace indexes existing blobs without changing bytes", async () => {
    const { workspaceDb } = await import("./workspace");
    const { runtimeSessionStorageBytes } = await import("./runtimeSessions");
    workspaceDb.close();
    await Dexie.delete(workspaceDb.name);
    const legacy = new Dexie(workspaceDb.name);
    legacy.version(5).stores({
      sources: "id, savedAt, [savedAt+size+id]",
      runtimeSessions: "tabId, lastTouched, blobHash",
      runtimePdfBlobs: "hash",
      tabPreviews: "tabId, capturedAt, [capturedAt+size+tabId]",
    });
    const blob = { hash: "legacy", size: 3, bytes: new Uint8Array([7, 8, 9]), refCount: 2 };
    try {
      await legacy.table("runtimePdfBlobs").put(blob);
      // Legacy sessions without snapshotSize must still count their history.
      await legacy.table("runtimeSessions").put({
        tabId: "legacy-tab", version: 1, blobHash: blob.hash,
        snapshot: { history: "preserved" }, lastTouched: 1,
      });
    } finally {
      legacy.close();
      await workspaceDb.open();
    }
    expect(workspaceDb.verno).toBe(6);
    expect(await workspaceDb.runtimePdfBlobs.get(blob.hash)).toEqual(blob);
    expect((await workspaceDb.runtimeSessions.get("legacy-tab"))?.snapshot).toEqual({ history: "preserved" });
    let reads = 0;
    const onRead = (row: unknown) => { reads++; return row; };
    workspaceDb.runtimePdfBlobs.hook("reading", onRead);
    try {
      expect(await runtimeSessionStorageBytes()).toBeGreaterThan(blob.size);
      expect(reads).toBe(0);
    } finally {
      workspaceDb.runtimePdfBlobs.hook("reading").unsubscribe(onRead);
    }
  });

  test("restores a dirty model and explicitly encoded Set/Map state", async () => {
    const { createPdfEditorStore } = await import("../editor/store/store");
    const {
      captureSuspendedPdfSnapshot,
      putRuntimeSession,
      readRuntimeSession,
      restoreSuspendedPdfSnapshot,
    } = await import("./runtimeSessions");
    const source = createPdfEditorStore();
    const ink = {
      type: "ink" as const,
      id: "ink-a",
      pageId: page.id,
      color: "#000000",
      width: 2,
      paths: [[{ x: 1, y: 2 }]],
    };
    source.getState().setOpened(
      {
        fileName: "dirty.pdf",
        fileSize: 3,
        doc: {} as never,
        bytes: new Uint8Array([1, 2, 3]),
      },
      [page],
    );
    source.setState({
      model: {
        pages: [page],
        overlays: [ink],
      },
      tool: "ink",
      scale: 1.75,
      fitMode: "none",
      selectedIds: ["ink-a"],
      activePageId: page.id,
      outlineSelection: { pageId: page.id, pdfTop: 42 },
      searchMatchHighlight: { pageId: page.id, charStart: 3, charEnd: 8 },
      editingOverlayId: "ink-a",
      collapsedNoteIds: ["note-a"],
      collapsedCalloutIds: ["callout-a"],
      collapsedThreadIds: ["callout-a"],
      undoStack: [{ pages: [page], overlays: [] }],
      redoStack: [{ pages: [page], overlays: [ink] }],
      completedLiveOperationIds: new Set(["op-a"]),
      pendingOverlayReveals: new Map([
        [
          "ink-a",
          {
            overlayId: "ink-a",
            offsetMs: 0,
            durationMs: 100,
          },
        ],
      ]),
      textDefaults: {
        fontSize: 18,
        color: "#123456",
        bold: true,
        italic: true,
        align: "right",
        fontFamily: "serif",
      },
      showThumbs: false,
      readerMode: true,
    });

    await putRuntimeSession({
      tabId: "dirty",
      bytes: new Uint8Array([1, 2, 3]),
      snapshot: captureSuspendedPdfSnapshot(source),
    });
    const stored = await readRuntimeSession("dirty");
    const restored = createPdfEditorStore();
    if (!stored) throw new Error("expected stored runtime session");
    restored.getState().setOpened(
      {
        fileName: "dirty.pdf",
        fileSize: 3,
        doc: {} as never,
        bytes: stored.bytes,
      },
      [{ ...page, widthPt: 1 }],
    );
    restoreSuspendedPdfSnapshot(restored, stored.snapshot);

    const state = restored.getState();
    expect(state.opened?.sourcePages).toEqual([page]);
    expect(state.model.overlays.map((item) => item.id)).toEqual(["ink-a"]);
    expect(state.tool).toBe("ink");
    expect(state.scale).toBe(1.75);
    expect(state.fitMode).toBe("none");
    expect(state.selectedIds).toEqual(["ink-a"]);
    expect(state.activePageId).toBe(page.id);
    expect(state.outlineSelection).toEqual({ pageId: page.id, pdfTop: 42 });
    expect(state.searchMatchHighlight).toEqual({
      pageId: page.id,
      charStart: 3,
      charEnd: 8,
    });
    expect(state.editingOverlayId).toBe("ink-a");
    expect(state.collapsedNoteIds).toEqual(["note-a"]);
    expect(state.collapsedCalloutIds).toEqual(["callout-a"]);
    expect(state.collapsedThreadIds).toEqual(["callout-a"]);
    expect(state.undoStack).toHaveLength(1);
    expect(state.redoStack).toHaveLength(1);
    expect([...state.completedLiveOperationIds]).toEqual(["op-a"]);
    expect([...state.pendingOverlayReveals.keys()]).toEqual(["ink-a"]);
    expect(state.textDefaults).toEqual({
      fontSize: 18,
      color: "#123456",
      bold: true,
      italic: true,
      align: "right",
      fontFamily: "serif",
    });
    expect(state.showThumbs).toBe(false);
    expect(state.readerMode).toBe(true);
    expect(state.pageJump).toBeNull();
    expect(state.historyFeedback).toBeNull();
    expect(state.liveOverlayReveals).toEqual([]);
    expect(state.pdfFontFaces).toEqual({});
    expect(state.pdfFontChars).toEqual({});
  });

  test("preserves redo after undoing back to the clean model", async () => {
    const { createPdfEditorStore } = await import("../editor/store/store");
    const {
      captureSuspendedPdfSnapshot,
      putRuntimeSession,
      readRuntimeSession,
      restoreSuspendedPdfSnapshot,
    } = await import("./runtimeSessions");
    const clean = { pages: [page], overlays: [] };
    const dirty = {
      pages: [page],
      overlays: [
        {
          type: "ink" as const,
          id: "redo-ink",
          pageId: page.id,
          color: "#000000",
          width: 2,
          paths: [[{ x: 1, y: 1 }]],
        },
      ],
    };
    const source = createPdfEditorStore();
    source.setState({ model: clean, undoStack: [], redoStack: [dirty] });
    await putRuntimeSession({
      tabId: "redo",
      bytes: new Uint8Array([4, 5, 6]),
      snapshot: captureSuspendedPdfSnapshot(source),
    });
    const stored = await readRuntimeSession("redo");
    const restored = createPdfEditorStore();
    if (!stored) throw new Error("expected stored runtime session");
    restoreSuspendedPdfSnapshot(restored, stored.snapshot);
    restored.getState().redo();
    expect(restored.getState().model.overlays[0]?.id).toBe("redo-ink");
  });

  test("keeps the previous resident-safe snapshot after a transaction failure", async () => {
    const { createPdfEditorStore } = await import("../editor/store/store");
    const {
      __runtimeSessionTest,
      captureSuspendedPdfSnapshot,
      putRuntimeSession,
      readRuntimeSession,
      RuntimeSessionSaveError,
    } = await import("./runtimeSessions");
    const store = createPdfEditorStore();
    const firstBytes = new Uint8Array([7, 8, 9]);
    await putRuntimeSession({
      tabId: "atomic",
      bytes: firstBytes,
      snapshot: captureSuspendedPdfSnapshot(store),
    });
    __runtimeSessionTest.setBeforeWrite(() => {
      const error = new Error("wrapped quota") as Error & { inner?: unknown };
      error.name = "QuotaExceededError";
      throw error;
    });

    await expect(
      putRuntimeSession({
        tabId: "atomic",
        bytes: new Uint8Array([10, 11, 12]),
        snapshot: captureSuspendedPdfSnapshot(store),
      }),
    ).rejects.toMatchObject({
      name: RuntimeSessionSaveError.name,
      kind: "quota",
    });
    expect((await readRuntimeSession("atomic"))?.bytes).toEqual(firstBytes);
    const { workspaceDb } = await import("./workspace");
    expect(await workspaceDb.runtimeSessions.count()).toBe(1);
    const blobs = await workspaceDb.runtimePdfBlobs.toArray();
    expect(blobs).toHaveLength(1);
    expect(blobs[0]?.refCount).toBe(1);
  });

  test("counts the suspended model and history against the storage cap", async () => {
    const { workspaceDb } = await import("./workspace");
    const {
      __runtimeSessionTest,
      captureSuspendedPdfSnapshot,
      putRuntimeSession,
      RuntimeSessionSaveError,
    } = await import("./runtimeSessions");
    const { createPdfEditorStore } = await import("../editor/store/store");
    const store = createPdfEditorStore();
    const largeModel = {
      pages: [page],
      overlays: [
        {
          type: "text" as const,
          id: "large-text",
          pageId: page.id,
          rect: { x: 0, y: 0, w: 100, h: 100 },
          text: "x".repeat(4_096),
          fontSize: 12,
          color: "#000000",
          bold: false,
          align: "left" as const,
          fontFamily: "sans" as const,
        },
      ],
    };
    store.setState({ model: largeModel, undoStack: [largeModel] });
    __runtimeSessionTest.setCapBytes(1_024);

    await expect(
      putRuntimeSession({
        tabId: "snapshot-over-cap",
        bytes: new Uint8Array([1]),
        snapshot: captureSuspendedPdfSnapshot(store),
      }),
    ).rejects.toMatchObject({
      name: RuntimeSessionSaveError.name,
      kind: "cap",
    });
    expect(await workspaceDb.runtimeSessions.count()).toBe(0);
    expect(await workspaceDb.runtimePdfBlobs.count()).toBe(0);
  });

  test("keeps encrypted-PDF credentials in memory and never in IndexedDB", async () => {
    const { createPdfEditorStore } = await import("../editor/store/store");
    const { workspaceDb } = await import("./workspace");
    const {
      __runtimeSessionTest,
      captureSuspendedPdfSnapshot,
      putRuntimeSession,
      rememberRuntimeCredential,
      runtimeCredential,
    } = await import("./runtimeSessions");
    rememberRuntimeCredential("encrypted", "reader-secret");
    await putRuntimeSession({
      tabId: "encrypted",
      bytes: new Uint8Array([19, 20, 21]),
      snapshot: captureSuspendedPdfSnapshot(createPdfEditorStore()),
    });
    const row = await workspaceDb.runtimeSessions.get("encrypted");
    expect(JSON.stringify(row)).not.toContain("reader-secret");
    expect(runtimeCredential("encrypted")).toBe("reader-secret");
    __runtimeSessionTest.clearCredentials();
    expect(runtimeCredential("encrypted")).toBeUndefined();
  });

  test("reference-count cleanup removes the blob only after the final tab", async () => {
    const { createPdfEditorStore } = await import("../editor/store/store");
    const { workspaceDb } = await import("./workspace");
    const {
      captureSuspendedPdfSnapshot,
      putRuntimeSession,
      removeRuntimeSession,
    } = await import("./runtimeSessions");
    const snapshot = captureSuspendedPdfSnapshot(createPdfEditorStore());
    const bytes = new Uint8Array([22, 23, 24]);
    await putRuntimeSession({ tabId: "ref-a", bytes, snapshot });
    await putRuntimeSession({ tabId: "ref-b", bytes, snapshot });
    expect((await workspaceDb.runtimePdfBlobs.toArray())[0]?.refCount).toBe(2);
    await removeRuntimeSession("ref-a");
    expect((await workspaceDb.runtimePdfBlobs.toArray())[0]?.refCount).toBe(1);
    await removeRuntimeSession("ref-b");
    expect(await workspaceDb.runtimePdfBlobs.count()).toBe(0);
  });

  test("startup repair removes orphan sessions/blobs and rebuilds refCounts", async () => {
    const { createPdfEditorStore } = await import("../editor/store/store");
    const { workspaceDb } = await import("./workspace");
    const {
      captureSuspendedPdfSnapshot,
      putRuntimeSession,
      repairRuntimeSessions,
    } = await import("./runtimeSessions");
    const snapshot = captureSuspendedPdfSnapshot(createPdfEditorStore());
    await putRuntimeSession({
      tabId: "retained",
      bytes: new Uint8Array([25, 26, 27]),
      snapshot,
    });
    await putRuntimeSession({
      tabId: "closed-tab",
      bytes: new Uint8Array([28, 29, 30]),
      snapshot,
    });
    const retained = await workspaceDb.runtimeSessions.get("retained");
    if (!retained) throw new Error("expected retained session");
    await workspaceDb.runtimePdfBlobs.update(retained.blobHash, { refCount: 9 });
    await workspaceDb.runtimePdfBlobs.put({
      hash: "orphan-blob",
      bytes: new Uint8Array([31]),
      size: 1,
      refCount: 4,
    });

    await repairRuntimeSessions(new Set(["retained"]));

    expect((await workspaceDb.runtimeSessions.toArray()).map((row) => row.tabId))
      .toEqual(["retained"]);
    const blobs = await workspaceDb.runtimePdfBlobs.toArray();
    expect(blobs).toHaveLength(1);
    expect(blobs[0]?.hash).toBe(retained.blobHash);
    expect(blobs[0]?.refCount).toBe(1);
  });
});
