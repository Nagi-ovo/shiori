import { describe, expect, test } from "bun:test";
import type { ContentTextOverlay, InkOverlay, PageModel } from "../../pdf/model/types";
import { createPdfEditorStore } from "./store";

const page = (id: string): PageModel => ({ id, sourceIndex: 0, rotation: 0, widthPt: 400, heightPt: 600 });
const edit = (id: string, pageId: string): ContentTextOverlay => ({
  type: "contentText", id, pageId, rect: { x: 10, y: 400, w: 200, h: 40 }, coverRects: [{ x: 10, y: 400, w: 200, h: 40 }],
  originalText: "old", text: "new", fontSize: 10, color: "#000000", bold: false, align: "left", fontFamily: "sans",
});
const ink = (id: string, pageId: string): InkOverlay => ({ type: "ink", id, pageId, paths: [[{ x: 1, y: 1 }]], color: "#000000", width: 1 });
const frames = (pageId: string) => [
  { pageId, rect: { x: 10, y: 400, w: 200, h: 40 } },
  { pageId, rect: { x: 10, y: 300, w: 200, h: 80 } },
] as const;

function opened(pages: PageModel[], overlays: ContentTextOverlay[] = []) {
  const store = createPdfEditorStore();
  store.setState({ model: { pages, overlays } });
  return store;
}

describe("linked text frames in the editor store", () => {
  test("linking records the chain, marks the first frame's edit, and is one undo step", () => {
    const store = opened([page("p1")], [edit("e1", "p1")]);
    const id = store.getState().linkTextFrames(...frames("p1"), "e1");
    const model = store.getState().model;
    expect(model.flowChains?.map((c) => c.id)).toEqual([id]);
    expect(model.flowChains?.[0]?.frames.map((f) => f.rect.y)).toEqual([400, 300]);
    expect((model.overlays[0] as ContentTextOverlay).flowChainId).toBe(id);
    store.getState().undo();
    expect(store.getState().model.flowChains ?? []).toEqual([]);
    expect((store.getState().model.overlays[0] as ContentTextOverlay).flowChainId).toBeUndefined();
    store.getState().redo();
    expect(store.getState().model.flowChains?.map((c) => c.id)).toEqual([id]);
  });

  test("ordinary edits keep the chain through commit and undo", () => {
    const store = opened([page("p1")], [edit("e1", "p1")]);
    const id = store.getState().linkTextFrames(...frames("p1"), "e1");
    store.getState().addOverlay(ink("i1", "p1"));
    expect(store.getState().model.flowChains?.map((c) => c.id)).toEqual([id]);
    store.getState().undo();
    expect(store.getState().model.flowChains?.map((c) => c.id)).toEqual([id]);
  });

  test("a history snapshot does not share frame rects with the live model", () => {
    const store = opened([page("p1")]);
    store.getState().linkTextFrames(...frames("p1"));
    store.getState().addOverlay(ink("i1", "p1"));
    const live = store.getState().model.flowChains![0]!.frames[0]!.rect;
    const snapshot = store.getState().undoStack.at(-1) as { flowChains?: { frames: { rect: unknown }[] }[] };
    expect(snapshot.flowChains?.[0]?.frames[0]?.rect).toEqual(live);
    expect(snapshot.flowChains?.[0]?.frames[0]?.rect).not.toBe(live);
  });

  test("unlinking removes the chain and turns the edit back into a single-frame edit", () => {
    const store = opened([page("p1")], [edit("e1", "p1")]);
    const id = store.getState().linkTextFrames(...frames("p1"), "e1");
    store.getState().unlinkTextFrames(id);
    expect(store.getState().model.flowChains).toEqual([]);
    expect((store.getState().model.overlays[0] as ContentTextOverlay).flowChainId).toBeUndefined();
  });

  test("deleting a page prunes every chain with a frame on it, and undo restores it", () => {
    const store = opened([page("p1"), page("p2"), page("p3")], [edit("e1", "p1")]);
    const kept = store.getState().linkTextFrames(...frames("p1"), "e1");
    store.getState().linkTextFrames(...frames("p2"));
    store.getState().deletePage("p2");
    expect(store.getState().model.flowChains?.map((c) => c.id)).toEqual([kept]);
    store.getState().deletePage("p1");
    expect(store.getState().model.flowChains).toEqual([]);
    store.getState().undo();
    expect(store.getState().model.flowChains?.map((c) => c.id)).toEqual([kept]);
  });

  test("duplicating a page does not copy its chains", () => {
    const store = opened([page("p1")]);
    const id = store.getState().linkTextFrames(...frames("p1"));
    store.getState().duplicatePage("p1");
    const model = store.getState().model;
    expect(model.pages).toHaveLength(2);
    expect(model.flowChains?.map((c) => c.id)).toEqual([id]);
    expect(model.flowChains?.[0]?.frames.every((f) => f.pageId === "p1")).toBe(true);
  });

  test("restoring a draft replaces the session's chains, and Undo returns to them", () => {
    const store = opened([page("p1")], [edit("e1", "p1")]);
    const live = store.getState().linkTextFrames(...frames("p1"), "e1");
    const draftChain = { id: "draft-chain", frames: frames("p1").map((f, i) => ({ ...f, id: `d${i}` })) };
    store.getState().commitRestoredDraft({ pages: [page("p1")], overlays: [{ ...edit("e1", "p1"), flowChainId: "draft-chain" }], flowChains: [draftChain] }, []);
    expect(store.getState().model.flowChains?.map((c) => c.id)).toEqual(["draft-chain"]);
    store.getState().commitRestoredDraft({ pages: [page("p1")], overlays: [], flowChains: [] }, []);
    expect(store.getState().model.flowChains).toEqual([]);
    store.getState().undo();
    store.getState().undo();
    expect(store.getState().model.flowChains?.map((c) => c.id)).toEqual([live]);
  });
});
