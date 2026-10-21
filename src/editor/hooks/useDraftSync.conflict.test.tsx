import "../../test/setupDom";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  IDBKeyRange as FakeIDBKeyRange,
  indexedDB as fakeIndexedDB,
} from "fake-indexeddb";
import Dexie from "dexie";
import type { PdfDocument as PDFDocumentProxy } from "../../pdf/engine/types";
import type { PageModel } from "../../pdf/model/types";

// setupDom points global indexedDB at the in-memory fake but wires Dexie's
// dependency separately, so set both here.
Dexie.dependencies.indexedDB = fakeIndexedDB as unknown as IDBFactory;
Dexie.dependencies.IDBKeyRange = FakeIDBKeyRange as unknown as typeof IDBKeyRange;

const HASH = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

const page: PageModel = {
  id: "p1",
  sourceIndex: 0,
  rotation: 0,
  widthPt: 100,
  heightPt: 200,
};

const highlight = (overlayId: string) => ({
  type: "highlight" as const,
  id: overlayId,
  pageId: "p1",
  rects: [{ x: 0, y: 0, w: 1, h: 1 }],
  color: "#ffff00",
  opacity: 0.4,
});

/**
 * Window A (a protection entry and direct draft writes) and this window (the
 * hook) on one remembered file handle: one draft id.
 */
async function twoWindowsOnOneHandle() {
  const { useEditorStore } = await import("../store/store");
  const { default: drafts } = await import("../../storage/drafts");
  const { draftIdFor } = await import("../../storage/draftIdentity");
  const { createDraftProtection } = await import("../../storage/draftProtection");
  const { useDraftSync } = await import("./useDraftSync");
  const id = draftIdFor(HASH, { type: "webFileHandle", id: "shared-handle" });
  const saveInWindowA = (overlayId: string) =>
    drafts.put({
      id,
      fileName: "paper.pdf",
      fileSize: 4,
      pdfBytes: new Uint8Array([1, 2, 3, 4]),
      model: { pages: [page], overlays: [highlight(overlayId)] },
      lastTouched: Date.now(),
    });
  const noop = () => 0;
  const windowA = createDraftProtection({
    storage: () => localStorage, now: Date.now, setTimeout: noop, clearTimeout: noop,
    target: null, sessionId: "window-a", locks: null,
  });
  const closeWindowA = windowA.protectOpenDrafts(() => [id]);
  const consoleError = spyOn(console, "error").mockImplementation(() => {});
  const openInThisWindow = (draftVersion: { lastTouched: number; revision: string | null } | null) =>
    act(() => {
      useEditorStore.getState().setOpened(
        {
          fileName: "paper.pdf",
          fileSize: 4,
          doc: {} as PDFDocumentProxy,
          bytes: new Uint8Array([1, 2, 3, 4]),
          webFileHandleId: "shared-handle",
          draftVersion,
        },
        [page],
      );
    });
  // Whether this window's copy is exported, as the export status reports it.
  const exportState = { exported: false };
  const view = renderHook(() => useDraftSync(HASH, false, () => exportState.exported));
  const flush = async () => {
    let failure: unknown = null;
    await act(async () => {
      await view.result.current.flushNowOrThrow().catch((err: unknown) => {
        failure = err;
      });
    });
    return failure;
  };
  const edit = (overlayId: string) =>
    act(() => {
      useEditorStore.getState().commit({ overlays: [highlight(overlayId)] });
    });
  const editAndFlush = async (overlayId: string) => {
    edit(overlayId);
    return flush();
  };
  const overlays = async () => (await drafts.get(id))?.model.overlays.map((o) => o.id);
  const dispose = async () => {
    view.unmount();
    closeWindowA();
    consoleError.mockRestore();
    await drafts.remove(id);
  };
  return {
    id, view, exportState, saveInWindowA, closeWindowA, openInThisWindow, edit, flush, editAndFlush, overlays, dispose,
  };
}

// Two browser windows (or two desktop windows on one path) share a draft id.
describe("useDraftSync across windows", () => {
  beforeEach(() => {
    cleanup();
  });
  afterEach(() => {
    cleanup();
  });

  test("a second window on the same file never overwrites the other's newer draft", async () => {
    const { useEditorStore } = await import("../store/store");
    const { readOperationLog } = await import("../../storage/operationLog");
    const w = await twoWindowsOnOneHandle();
    const { id } = w;
    try {
      // This window read A's draft as A last saved it: its save may go on.
      w.openInThisWindow(await w.saveInWindowA("a-1"));
      expect(await w.editAndFlush("b-1")).toBeNull();
      expect(await w.overlays()).toEqual(["b-1"]);

      // A saves on top meanwhile; this window's next save would undo A's work.
      await w.saveInWindowA("a-2");
      expect(await w.editAndFlush("b-2")).not.toBeNull();
      expect(w.view.result.current.errorKind).toBe("conflict");
      expect(await w.overlays()).toEqual(["a-2"]);
      // Its crash log must not outrank A's draft on the next open either.
      expect(readOperationLog(id)).toBeNull();

      // Reopened from A's latest draft, it logs edits again.
      w.openInThisWindow(await w.saveInWindowA("a-3"));
      act(() => useEditorStore.getState().commit({ overlays: [highlight("b-3")] }));
      await act(() => Bun.sleep(400));
      expect(readOperationLog(id)).not.toBeNull();
    } finally {
      await w.dispose();
    }
  });

  test("a window that closed after saving keeps its draft from the other's stale save", async () => {
    const w = await twoWindowsOnOneHandle();
    try {
      w.openInThisWindow(await w.saveInWindowA("a-1"));
      // A saves newer work and closes before this window saves.
      await w.saveInWindowA("a-2");
      w.closeWindowA();

      expect(await w.editAndFlush("b-1")).not.toBeNull();
      expect(w.view.result.current.errorKind).toBe("conflict");
      expect(await w.overlays()).toEqual(["a-2"]);
    } finally {
      await w.dispose();
    }
  });

  // Close, tab switch and quit all wait on the strict flush. After a refusal
  // its retry is refused too; once this copy is exported, leaving loses
  // nothing and must go through, still without touching the other's row.
  test("a refused window can leave its copy once it is exported", async () => {
    const w = await twoWindowsOnOneHandle();
    try {
      w.openInThisWindow(await w.saveInWindowA("a-1"));
      await w.saveInWindowA("a-2");
      expect(await w.editAndFlush("b-1")).not.toBeNull();
      expect(await w.flush()).not.toBeNull();

      w.exportState.exported = true;
      expect(await w.flush()).toBeNull();
      expect(await w.overlays()).toEqual(["a-2"]);

      // A new edit is unexported again: leaving would lose it.
      w.exportState.exported = false;
      expect(await w.editAndFlush("b-2")).not.toBeNull();
      expect(await w.overlays()).toEqual(["a-2"]);
    } finally {
      await w.dispose();
    }
  });

  // Instead of exporting, the reader may drop the refused copy: the blocked
  // leave goes on, the other window's draft stays, and no crash log can bring
  // this copy back on the next open as if it had been saved.
  test("a refused window can discard its copy and leave", async () => {
    const { readOperationLog } = await import("../../storage/operationLog");
    const w = await twoWindowsOnOneHandle();
    try {
      w.openInThisWindow(await w.saveInWindowA("a-1"));
      await w.saveInWindowA("a-2");
      w.edit("b-1");
      await act(() => Bun.sleep(400));
      expect(await w.flush()).not.toBeNull();

      let discarded = false;
      act(() => {
        discarded = w.view.result.current.discardRefusedEdits();
      });
      expect(discarded).toBe(true);
      expect(await w.flush()).toBeNull();
      expect(await w.overlays()).toEqual(["a-2"]);
      expect(readOperationLog(w.id)).toBeNull();
      await act(() => Bun.sleep(900));
      expect(await w.overlays()).toEqual(["a-2"]);
      expect(readOperationLog(w.id)).toBeNull();

      // A new edit is unsaved again: leaving would lose it.
      expect(await w.editAndFlush("b-2")).not.toBeNull();
      expect(await w.overlays()).toEqual(["a-2"]);
    } finally {
      await w.dispose();
    }
  });

  test("discarding never drops edits a save can still keep", async () => {
    const w = await twoWindowsOnOneHandle();
    try {
      w.openInThisWindow(await w.saveInWindowA("a-1"));
      w.edit("b-1");
      let discarded = true;
      act(() => {
        discarded = w.view.result.current.discardRefusedEdits();
      });
      expect(discarded).toBe(false);
      expect(await w.flush()).toBeNull();
      expect(await w.overlays()).toEqual(["b-1"]);
    } finally {
      await w.dispose();
    }
  });

  // The crash log lands at 250 ms, before the 800 ms save that would find
  // the conflict. A crash between the two must not let it outrank A's draft.
  test("a crash log written before the refusal does not outrank the other's draft", async () => {
    const { readOperationLog } = await import("../../storage/operationLog");
    const { default: drafts } = await import("../../storage/drafts");
    const { chooseDraftRecovery } = await import("../../workspace/intake/recovery");
    const w = await twoWindowsOnOneHandle();
    try {
      w.openInThisWindow(await w.saveInWindowA("a-1"));
      await w.saveInWindowA("a-2");
      w.edit("b-1");
      await act(() => Bun.sleep(400));
      expect(readOperationLog(w.id)).not.toBeNull();

      // The browser crashes here; the next open picks what to restore.
      const recovery = chooseDraftRecovery(await drafts.get(w.id), readOperationLog(w.id), [page], []);
      expect(recovery?.overlays.map((o) => o.id)).toEqual(["a-2"]);
    } finally {
      await w.dispose();
    }
  });
});
