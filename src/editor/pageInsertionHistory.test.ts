import { describe, expect, test } from "bun:test";
import type { DocumentModel, Overlay, PageModel } from "../pdf/model/types";
import { createPdfEditorStore } from "./store/store";

describe("PDF page insertion history", () => {
  test("replacement bytes preserve old Undo while insertion clears stale Redo", () => {
    const store = createPdfEditorStore();
    const basePages = [page("base-1", 0), page("base-2", 1)];
    const inserted = page("inserted", 2);
    const sourcePages = [...basePages, inserted];
    const existingOverlay: Overlay = {
      id: "existing-note",
      type: "note" as const,
      pageId: "base-1",
      rect: { x: 20, y: 30, w: 24, h: 24 },
      text: "Keep me",
      color: "#f4d674",
      createdAt: 1,
      updatedAt: 1,
    };
    const insertedOverlay: Overlay = {
      ...existingOverlay,
      id: "incoming-note",
      pageId: "inserted",
      text: "From inserted PDF",
    };
    const pristine: DocumentModel = {
      pages: basePages,
      overlays: [],
    };
    const baseline: DocumentModel = {
      pages: basePages,
      overlays: [existingOverlay],
    };
    const merged: DocumentModel = {
      pages: [basePages[0]!, inserted, basePages[1]!],
      overlays: [existingOverlay, insertedOverlay],
    };

    store.getState().setOpened(
      {
        fileName: "paper.pdf",
        fileSize: 1,
        doc: {} as never,
        bytes: new Uint8Array([1]),
      },
      basePages,
      pristine,
      { completedLiveOperationIds: ["live-before-merge"] },
    );
    // Existing edit, followed by a second edit that is undone. A new insertion
    // must retain the first edit's Undo target but invalidate the stale Redo.
    store.getState().commit(baseline);
    store.getState().commit({
      pages: [{ ...basePages[0]!, rotation: 90 }, basePages[1]!],
    });
    store.getState().undo();
    expect(store.getState().redoStack).toHaveLength(1);
    const preInsertionModel = store.getState().model;

    store.getState().setOpened(
      {
        fileName: "paper.pdf",
        fileSize: 2,
        doc: {} as never,
        bytes: new Uint8Array([1, 2]),
      },
      sourcePages,
      preInsertionModel,
      { preserveHistory: true },
    );
    store.getState().commit(merged);
    store.getState().setActivePage(inserted.id);

    expect(store.getState().undoStack).toHaveLength(2);
    expect(store.getState().redoStack).toHaveLength(0);
    expect([...store.getState().completedLiveOperationIds]).toEqual([
      "live-before-merge",
    ]);

    store.getState().undo();
    expect(store.getState().model.pages.map((item) => item.id)).toEqual([
      "base-1",
      "base-2",
    ]);
    expect(store.getState().model.overlays.map((item) => item.id)).toEqual([
      "existing-note",
    ]);
    expect(store.getState().activePageId).toBe("base-2");

    // The next Undo crosses the merge boundary into the reader's old history.
    store.getState().undo();
    expect(store.getState().model).toEqual(pristine);

    store.getState().redo();
    expect(store.getState().model).toEqual(baseline);
    store.getState().redo();
    expect(store.getState().model.pages.map((item) => item.id)).toEqual([
      "base-1",
      "inserted",
      "base-2",
    ]);
    expect(store.getState().model.overlays.map((item) => item.id)).toEqual([
      "existing-note",
      "incoming-note",
    ]);
  });

  test("preserveHistory rejects a stale model or a shrinking physical source", () => {
    const store = createPdfEditorStore();
    const pages = [page("first", 0), page("second", 1)];
    store.getState().setOpened(
      {
        fileName: "paper.pdf",
        fileSize: 1,
        doc: {} as never,
        bytes: new Uint8Array([1]),
      },
      pages,
    );
    const liveModel = store.getState().model;

    expect(() =>
      store.getState().setOpened(
        {
          fileName: "paper.pdf",
          fileSize: 2,
          doc: {} as never,
          bytes: new Uint8Array([1, 2]),
        },
        [...pages, page("inserted", 2)],
        { pages: liveModel.pages, overlays: liveModel.overlays },
        { preserveHistory: true },
      ),
    ).toThrow("requires the live model");
    expect(() =>
      store.getState().setOpened(
        {
          fileName: "paper.pdf",
          fileSize: 2,
          doc: {} as never,
          bytes: new Uint8Array([1, 2]),
        },
        [pages[0]!],
        liveModel,
        { preserveHistory: true },
      ),
    ).toThrow("cannot remove physical pages");
  });
});

function page(id: string, sourceIndex: number): PageModel {
  return {
    id,
    sourceIndex,
    rotation: 0,
    widthPt: 612,
    heightPt: 792,
  };
}
