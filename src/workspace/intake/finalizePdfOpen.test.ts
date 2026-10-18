import { describe, expect, test } from "bun:test";
import { createPdfEditorStore } from "../../editor/store/store";
import type { Overlay, PageModel } from "../../pdf/model/types";
import { finalizePdfOpen, type FinalizePdfOpen } from "./finalizePdfOpen";

const page = (id: string, sourceIndex: number): PageModel => ({
  id,
  sourceIndex,
  rotation: 0,
  widthPt: 612,
  heightPt: 792,
});

const note = (id: string, pageId: string): Overlay => ({
  id,
  type: "note",
  pageId,
  rect: { x: 20, y: 30, w: 24, h: 24 },
  text: id,
  color: "#f4d674",
  createdAt: 1,
  updatedAt: 1,
});

function open(overrides: Partial<FinalizePdfOpen> & Pick<FinalizePdfOpen, "store">) {
  finalizePdfOpen({
    file: { name: "paper.pdf", size: 1 },
    hash: "hash",
    pages: [page("p1", 0), page("p2", 1)],
    doc: {} as never,
    bytes: new Uint8Array([1]),
    source: {},
    animateImportedCallouts: false,
    ...overrides,
  });
}

describe("finalizePdfOpen", () => {
  test("merging pages keeps the Live receipts the document already had", () => {
    const store = createPdfEditorStore();
    open({ store, completedLiveOperationIds: ["live-1"] });
    const pages = [page("p1", 0), page("p2", 1), page("p3", 2)];

    open({
      store,
      pages,
      model: {
        pages,
        overlays: [],
        historyBaseline: store.getState().model,
        preserveHistory: true,
      },
      modelAsEdit: true,
    });

    expect([...store.getState().completedLiveOperationIds]).toEqual(["live-1"]);
    expect(store.getState().model.pages).toHaveLength(3);
  });

  test("a merge can be undone; imported annotations cannot", () => {
    const store = createPdfEditorStore();
    open({
      store,
      model: { pages: [page("p1", 0), page("p2", 1)], overlays: [note("n", "p1")] },
    });
    expect(store.getState().undoStack).toHaveLength(0);
    const pages = [page("p1", 0), page("p2", 1), page("p3", 2)];

    open({
      store,
      pages,
      model: {
        pages,
        overlays: store.getState().model.overlays,
        historyBaseline: store.getState().model,
        preserveHistory: true,
      },
      modelAsEdit: true,
    });
    expect(store.getState().model.pages).toHaveLength(3);
    store.getState().undo();

    expect(store.getState().model.pages).toHaveLength(2);
    expect(store.getState().model.overlays.map((o) => o.id)).toEqual(["n"]);
  });

  test("opens at the last-read page, or the first when it no longer exists", () => {
    const resumed = createPdfEditorStore();
    open({ store: resumed, resumePageIndex: 1 });
    const outOfRange = createPdfEditorStore();
    open({ store: outOfRange, resumePageIndex: 7 });

    expect(resumed.getState().activePageId).toBe("p2");
    expect(outOfRange.getState().activePageId).toBe("p1");
  });

  test("keeps collapsed notes a pending draft owns, and prunes them otherwise", () => {
    const view = {
      collapsedNoteIds: ["from-draft"],
      collapsedCalloutIds: [],
    } as unknown as FinalizePdfOpen["view"];
    const pending = createPdfEditorStore();
    open({ store: pending, view, keepUnmatchedCollapsedIds: true });
    const settled = createPdfEditorStore();
    open({ store: settled, view });

    expect([...pending.getState().collapsedNoteIds]).toEqual(["from-draft"]);
    expect([...settled.getState().collapsedNoteIds]).toEqual([]);
  });
});
