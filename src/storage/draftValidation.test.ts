import { describe, expect, test } from "bun:test";
import Dexie from "dexie";
import {
  IDBKeyRange as FakeIDBKeyRange,
  indexedDB as fakeIndexedDB,
} from "fake-indexeddb";
import type { DocumentModel, Overlay } from "../pdf/model/types";

Dexie.dependencies.indexedDB = fakeIndexedDB as unknown as IDBFactory;
Dexie.dependencies.IDBKeyRange = FakeIDBKeyRange as unknown as typeof IDBKeyRange;

const page = { id: "p1", sourceIndex: 0, rotation: 0 as const, widthPt: 100, heightPt: 100 };

function modelWith(overlays: Overlay[]): DocumentModel {
  return { pages: [page], overlays };
}

describe("persisted undo history", () => {
  // The importer keeps a /BS << /W 0 >> border as width 0: a filled box or a
  // redaction mark with no outline. Every undo snapshot carries that overlay.
  test.each<[string, Overlay]>([
    [
      "a borderless filled square",
      { type: "rect", id: "r1", pageId: "p1", rect: { x: 1, y: 1, w: 10, h: 10 }, color: "#000000", strokeWidth: 0, fill: "#ff0000" },
    ],
    [
      "zero-width ink",
      { type: "ink", id: "i1", pageId: "p1", paths: [[{ x: 1, y: 1 }, { x: 5, y: 5 }]], color: "#0000ff", width: 0 },
    ],
    [
      "a zero-width stamp",
      { type: "stamp", id: "s1", pageId: "p1", kind: "check", rect: { x: 1, y: 1, w: 10, h: 10 }, color: "#00aa00", strokeWidth: 0 },
    ],
  ])("survives a reload with %s imported from the PDF", async (_label, imported) => {
    const { default: drafts, __draftsTest } = await import("./drafts");
    await __draftsTest.reset();
    const note: Overlay = {
      type: "note", id: "n1", pageId: "p1", rect: { x: 50, y: 50, w: 20, h: 20 }, text: "hi", color: "#ffcc00",
    };
    await drafts.put({
      id: "imported-borderless",
      fileName: "imported.pdf",
      fileSize: 1,
      pdfBytes: new Uint8Array([1]),
      model: modelWith([imported, note, { ...note, id: "n2" }]),
      history: [modelWith([imported]), modelWith([imported, note])],
      lastTouched: 10,
    });

    const restored = await drafts.get("imported-borderless");
    expect(restored?.history).toHaveLength(2);
  });
});

// Validation is tested without Dexie: the IndexedDB-backed suites above lose
// their database in the full run, and sanitizeHistory is what guards Undo.
describe("linked text frames in persisted history", () => {
  const chain = { id: "c1", frames: [
    { id: "f0", pageId: "p1", rect: { x: 10, y: 60, w: 80, h: 30 } },
    { id: "f1", pageId: "p1", rect: { x: 10, y: 10, w: 80, h: 40 } },
  ] };
  const edit: Overlay = {
    type: "contentText", id: "e1", pageId: "p1", rect: { x: 10, y: 60, w: 80, h: 30 }, coverRects: [{ x: 10, y: 60, w: 80, h: 30 }],
    originalText: "old", text: "new", fontSize: 10, color: "#000000", bold: false, align: "left", fontFamily: "sans", backgroundColor: "#ffffff", flowChainId: "c1",
  };

  test("keeps a snapshot with a chain and a legacy snapshot without one", async () => {
    const { sanitizeHistory } = await import("./draftValidation");
    const chained: DocumentModel = { ...modelWith([edit]), flowChains: [chain] };
    const restored = sanitizeHistory([modelWith([]), chained]);
    expect(restored).toHaveLength(2);
    expect((restored[0] as DocumentModel).flowChains).toBeUndefined();
    expect((restored[1] as DocumentModel).flowChains).toEqual([chain]);
  });

  test.each([
    ["a frame on a page the model does not have", { ...chain, frames: [chain.frames[0], { ...chain.frames[1], pageId: "gone" }] }],
    ["a chain with one frame", { ...chain, frames: [chain.frames[0]] }],
    ["a frame with no area", { ...chain, frames: [chain.frames[0], { ...chain.frames[1], rect: { x: 0, y: 0, w: 0, h: 5 } }] }],
  ])("drops a snapshot whose chain has %s before it can reach Undo", async (_label, bad) => {
    const { sanitizeHistory } = await import("./draftValidation");
    expect(sanitizeHistory([modelWith([]), { ...modelWith([]), flowChains: [bad] }])).toHaveLength(1);
  });
});
