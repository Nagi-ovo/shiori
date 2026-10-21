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

// Two browser windows (or two desktop windows on one path) share a draft id.
describe("useDraftSync across windows", () => {
  beforeEach(() => {
    cleanup();
  });
  afterEach(() => {
    cleanup();
  });

  test("a second window on the same file never overwrites the other's newer draft", async () => {
    // Two browser windows opened one remembered file handle: one draft id.
    const { useEditorStore } = await import("../store/store");
    const { default: drafts } = await import("../../storage/drafts");
    const { draftIdFor } = await import("../../storage/draftIdentity");
    const { createDraftProtection } = await import("../../storage/draftProtection");
    const { readOperationLog } = await import("../../storage/operationLog");
    const { useDraftSync } = await import("./useDraftSync");
    const id = draftIdFor(HASH, { type: "webFileHandle", id: "shared-handle" });
    const highlight = (overlayId: string) => ({
      type: "highlight" as const,
      id: overlayId,
      pageId: "p1",
      rects: [{ x: 0, y: 0, w: 1, h: 1 }],
      color: "#ffff00",
      opacity: 0.4,
    });
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
    const releaseA = windowA.protectOpenDrafts(() => [id]);
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
    const view = renderHook(() => useDraftSync(HASH, false));
    const editAndFlush = async (overlayId: string) => {
      act(() => {
        useEditorStore.getState().commit({ overlays: [highlight(overlayId)] });
      });
      let failure: unknown = null;
      await act(async () => {
        await view.result.current.flushNowOrThrow().catch((err: unknown) => {
          failure = err;
        });
      });
      return failure;
    };
    const overlays = async () => (await drafts.get(id))?.model.overlays.map((o) => o.id);
    try {
      // This window read A's draft as A last saved it: its save may go on.
      openInThisWindow(await saveInWindowA("a-1"));
      expect(await editAndFlush("b-1")).toBeNull();
      expect(await overlays()).toEqual(["b-1"]);

      // A saves on top meanwhile; this window's next save would undo A's work.
      await saveInWindowA("a-2");
      expect(await editAndFlush("b-2")).not.toBeNull();
      expect(view.result.current.errorKind).toBe("conflict");
      expect(await overlays()).toEqual(["a-2"]);
      // Its crash log must not outrank A's draft on the next open either.
      expect(readOperationLog(id)).toBeNull();

      // Reopened from A's latest draft, it logs edits again.
      openInThisWindow(await saveInWindowA("a-3"));
      act(() => useEditorStore.getState().commit({ overlays: [highlight("b-3")] }));
      await act(() => Bun.sleep(400));
      expect(readOperationLog(id)).not.toBeNull();
    } finally {
      view.unmount();
      releaseA();
      consoleError.mockRestore();
      await drafts.remove(id);
    }
  });
});
