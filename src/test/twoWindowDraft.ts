import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { spyOn } from "bun:test";
import {
  IDBKeyRange as FakeIDBKeyRange,
  indexedDB as fakeIndexedDB,
} from "fake-indexeddb";
import Dexie from "dexie";
import type { DraftSyncState } from "../editor/hooks/useDraftSync";
import type { PdfDocument as PDFDocumentProxy } from "../pdf/engine/types";
import type { PageModel } from "../pdf/model/types";

// setupDom points global indexedDB at the in-memory fake but wires Dexie's
// dependency separately, so set both here.
Dexie.dependencies.indexedDB = fakeIndexedDB as unknown as IDBFactory;
Dexie.dependencies.IDBKeyRange = FakeIDBKeyRange as unknown as typeof IDBKeyRange;

export const HASH = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

export const page: PageModel = {
  id: "p1",
  sourceIndex: 0,
  rotation: 0,
  widthPt: 100,
  heightPt: 200,
};

export const highlight = (overlayId: string) => ({
  type: "highlight" as const,
  id: overlayId,
  pageId: "p1",
  rects: [{ x: 0, y: 0, w: 1, h: 1 }],
  color: "#ffff00",
  opacity: 0.4,
});

/**
 * Window A (a protection entry and direct draft writes) and this window (the
 * hook) on one remembered file handle: one draft id. `alongside` runs more
 * hooks in this window on its draft state, as PdfDraftController does.
 */
export async function twoWindowsOnOneHandle(
  alongside?: (draft: DraftSyncState, isExported: () => boolean) => void,
) {
  const { createPdfEditorStore, EditorStoreContext } = await import("../editor/store/store");
  const { default: drafts } = await import("../storage/drafts");
  const { draftIdFor } = await import("../storage/draftIdentity");
  const { createDraftProtection } = await import("../storage/draftProtection");
  const { useDraftSync } = await import("../editor/hooks/useDraftSync");
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
  // This window's editor, as the workspace tab on screen provides it.
  const editor = createPdfEditorStore();
  const consoleError = spyOn(console, "error").mockImplementation(() => {});
  const openInThisWindow = (
    draftVersion: { lastTouched: number; revision: string | null } | null,
    webFileHandleId = "shared-handle",
  ) =>
    act(() => {
      editor.getState().setOpened(
        {
          fileName: "paper.pdf",
          fileSize: 4,
          doc: {} as PDFDocumentProxy,
          bytes: new Uint8Array([1, 2, 3, 4]),
          webFileHandleId,
          draftVersion,
        },
        [page],
      );
    });
  // Whether this window's copy is exported, as the export status reports it.
  const exportState = { exported: false };
  const isExported = () => exportState.exported;
  const view = renderHook(
    () => {
      const draft = useDraftSync(HASH, false, isExported);
      alongside?.(draft, isExported);
      return draft;
    },
    {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(EditorStoreContext.Provider, { value: editor }, children),
    },
  );
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
      editor.getState().commit({ overlays: [highlight(overlayId)] });
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
