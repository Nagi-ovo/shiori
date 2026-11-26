import { describe, expect, test } from "bun:test";
import type { ContentTextOverlay, DocumentModel, PageModel } from "../../pdf/model/types";
import { exportModelForPages } from "./exportModel";
import { exportSnapshotKey } from "./exportStatus";

const page = (id: string): PageModel => ({ id, sourceIndex: 0, rotation: 0, widthPt: 400, heightPt: 600 });
const edit = (id: string, pageId: string, flowChainId?: string): ContentTextOverlay => ({
  type: "contentText", id, pageId, rect: { x: 10, y: 400, w: 200, h: 40 }, coverRects: [], originalText: "old", text: "new",
  fontSize: 10, color: "#000000", bold: false, align: "left", fontFamily: "sans", ...(flowChainId ? { flowChainId } : {}),
});
const chain = (id: string, pages: [string, string]) => ({ id, frames: pages.map((pageId, i) => ({ id: `${id}-${i}`, pageId, rect: { x: 10, y: 400 - 100 * i, w: 200, h: 40 } })) });
const model: DocumentModel = {
  pages: [page("p1"), page("p2")],
  overlays: [edit("e1", "p1", "c1"), edit("e2", "p2", "c2")],
  flowChains: [chain("c1", ["p1", "p1"]), chain("c2", ["p1", "p2"])],
};

describe("the model an export writes", () => {
  test("a whole-document export carries every chain and every chained edit", () => {
    const out = exportModelForPages(model, model.pages);
    expect(out.flowChains?.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(out.overlays.map((o) => (o as ContentTextOverlay).flowChainId)).toEqual(["c1", "c2"]);
  });

  test("a page range drops a chain that loses a page and turns its edit into a single-frame edit", () => {
    const out = exportModelForPages(model, [page("p1")]);
    expect(out.flowChains?.map((c) => c.id)).toEqual(["c1"]);
    expect(out.overlays.map((o) => (o as ContentTextOverlay).flowChainId)).toEqual(["c1", undefined]);
  });

  test("leaves an unresolved link for the writer to refuse", () => {
    const unresolved: DocumentModel = {
      ...model,
      overlays: [edit("dangling", "p1", "unknown"), edit("missing-page", "p1", "c3")],
      flowChains: [...model.flowChains!, chain("c3", ["p1", "missing"])],
    };
    const out = exportModelForPages(unresolved, [model.pages[0]!]);
    expect(out.flowChains?.map(c => c.id)).toEqual(["c1", "c3"]);
    expect(out.overlays).toEqual(unresolved.overlays);
  });

  test("a model without chains exports without the key", () => {
    expect("flowChains" in exportModelForPages({ pages: [page("p1")], overlays: [] }, [page("p1")])).toBe(false);
  });
});

describe("export snapshot identity", () => {
  test("linking frames makes the exported snapshot stale", () => {
    const plain: DocumentModel = { pages: model.pages, overlays: model.overlays };
    expect(exportSnapshotKey(model)).not.toBe(exportSnapshotKey(plain));
  });
  test("a model without chains keeps the key it had before chains existed", () => {
    const plain: DocumentModel = { pages: model.pages, overlays: model.overlays };
    expect(exportSnapshotKey({ ...plain, flowChains: [] })).toBe(exportSnapshotKey(plain));
  });
});
