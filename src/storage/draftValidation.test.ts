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
