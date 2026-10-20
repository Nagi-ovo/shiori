import { describe, expect, test } from "bun:test";
import type { Overlay, PageModel } from "../../pdf/model/types";
import { createPdfEditorStore } from "./store";

// What can go wrong with undo and redo (store.test.ts is at its size cap, so
// these live here):
// - restoring a snapshot hands back fresh page objects for pages no edit
//   touched. Every mounted text layer and thumbnail keys its work on the
//   page object, so one Cmd+Z after adding a highlight re-read and rebuilt
//   each mounted text layer (dropping the reader's selection) and
//   re-rasterized every mounted thumbnail.

const pages: PageModel[] = [0, 1, 2].map((index) => ({
  id: `p${index}`,
  sourceIndex: index,
  rotation: 0,
  widthPt: 612,
  heightPt: 792,
}));

const highlight: Overlay = {
  type: "highlight",
  id: "h1",
  pageId: "p0",
  rects: [{ x: 10, y: 10, w: 40, h: 8 }],
  color: "#ffd400",
  opacity: 0.4,
};

describe("undo and redo", () => {
  test("hand back the same page objects when only annotations changed", () => {
    const store = createPdfEditorStore();
    store.setState({ model: { pages, overlays: [] } });

    store.getState().addOverlay(highlight);
    store.getState().undo();
    expect(store.getState().model.overlays).toEqual([]);
    expect(store.getState().model.pages).toBe(pages);

    store.getState().redo();
    expect(store.getState().model.overlays).toEqual([highlight]);
    expect(store.getState().model.pages).toBe(pages);
  });

  test("still restore a page an edit replaced", () => {
    const store = createPdfEditorStore();
    store.setState({ model: { pages, overlays: [] } });

    store.getState().rotatePage("p1", 90);
    expect(store.getState().model.pages[1]!.rotation).toBe(90);
    store.getState().undo();

    expect(store.getState().model.pages[1]!.rotation).toBe(0);
    expect(store.getState().model.pages[0]).toBe(pages[0]!);
    store.getState().redo();
    expect(store.getState().model.pages[1]!.rotation).toBe(90);
  });
});
