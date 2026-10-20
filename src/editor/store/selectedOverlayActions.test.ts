import { describe, expect, test } from "bun:test";
import type { Overlay, PageModel } from "../../pdf/model/types";
import { createPdfEditorStore } from "./store";

// What can go wrong editing the selected overlays (store.test.ts is at its
// size cap, so these live here):
// - an edit that changes nothing still records an undo step and clears redo
//   (Delete on a selection that is all locked);
// - a duplicate lands exactly on its original, so nothing visible happens
//   and a hidden twin exports with the page (ink and signatures, whose
//   geometry is paths, not a rect).

const page: PageModel = { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 };

const rect = (id: string, locked = false): Overlay => ({
  type: "rect",
  id,
  pageId: page.id,
  rect: { x: 100, y: 100, w: 50, h: 50 },
  color: "#000000",
  fill: null,
  strokeWidth: 1,
  ...(locked ? { locked } : {}),
});

/** A store with one undone edit, so redo has an entry to lose. */
function storeWithRedo(overlays: Overlay[]) {
  const store = createPdfEditorStore();
  store.setState({ model: { pages: [page], overlays } });
  store.getState().addOverlay(rect("undone"));
  store.getState().undo();
  expect(store.getState().redoStack).toHaveLength(1);
  return store;
}

describe("selected overlay actions", () => {
  test("Cmd+D offsets an ink stroke like every other copy", () => {
    const store = createPdfEditorStore();
    const ink: Overlay = {
      type: "ink",
      id: "ink",
      pageId: page.id,
      paths: [[{ x: 10, y: 10 }, { x: 50, y: 50 }]],
      color: "#000000",
      width: 2,
    };
    const callout: Overlay = {
      type: "callout",
      id: "callout",
      pageId: page.id,
      targetRects: [{ x: 10, y: 10, w: 20, h: 5 }],
      leader: [{ x: 20, y: 15 }, { x: 60, y: 60 }],
      rect: { x: 60, y: 60, w: 80, h: 30 },
      text: "why",
      fontSize: 12,
      color: "#000000",
      bold: false,
      align: "left",
      fontFamily: "sans",
    };
    store.setState({ model: { pages: [page], overlays: [ink, rect("box"), callout] } });
    store.getState().setSelected(["ink", "box", "callout"]);

    store.getState().duplicateSelected();

    const [, , , inkCopy, boxCopy, calloutCopy] = store.getState().model.overlays;
    expect(inkCopy).toMatchObject({ type: "ink", paths: [[{ x: 22, y: -2 }, { x: 62, y: 38 }]] });
    expect(boxCopy).toMatchObject({ type: "rect", rect: { x: 112, y: 88, w: 50, h: 50 } });
    // A callout copy moves with its target and leader, as it always has.
    expect(calloutCopy).toMatchObject({
      type: "callout",
      rect: { x: 72, y: 48, w: 80, h: 30 },
      targetRects: [{ x: 22, y: -2, w: 20, h: 5 }],
      leader: [{ x: 32, y: 3 }, { x: 72, y: 48 }],
    });
    expect(store.getState().selectedIds).toEqual([inkCopy!.id, boxCopy!.id, calloutCopy!.id]);
  });

  test("Delete on a selection that is all locked records no history", () => {
    const store = storeWithRedo([rect("locked", true)]);
    store.getState().setSelected(["locked"]);

    store.getState().removeSelected();

    expect(store.getState().model.overlays.map((o) => o.id)).toEqual(["locked"]);
    expect(store.getState().undoStack).toHaveLength(0);
    expect(store.getState().redoStack).toHaveLength(1);
  });

  test("Delete still removes the unlocked part of a mixed selection, as one step", () => {
    const store = storeWithRedo([rect("locked", true), rect("free")]);
    store.getState().setSelected(["locked", "free"]);

    store.getState().removeSelected();

    expect(store.getState().model.overlays.map((o) => o.id)).toEqual(["locked"]);
    expect(store.getState().undoStack).toHaveLength(1);
  });
});
