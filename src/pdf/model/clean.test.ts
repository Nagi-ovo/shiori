import { describe, expect, test } from "bun:test";
import { isModelClean } from "./clean";
import type { DocumentModel, PageModel } from "./types";

const sourcePages: PageModel[] = [
  { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 },
  { id: "p2", sourceIndex: 1, rotation: 90, widthPt: 792, heightPt: 612 },
];

describe("clean document model detection", () => {
  test("treats deleted-all overlays as clean only when pages match the source", () => {
    expect(isModelClean(model(sourcePages, []), sourcePages)).toBe(true);
    expect(isModelClean(model(sourcePages, [highlight("p1")]), sourcePages)).toBe(false);
    expect(isModelClean(model([sourcePages[1]!, sourcePages[0]!], []), sourcePages)).toBe(false);
    expect(
      isModelClean(
        model([{ ...sourcePages[0]!, rotation: 90 }, sourcePages[1]!], []),
        sourcePages,
      ),
    ).toBe(false);
    expect(
      isModelClean(
        model([{ ...sourcePages[0]!, blank: true }, sourcePages[1]!], []),
        sourcePages,
      ),
    ).toBe(false);
  });
});

function model(
  pages: PageModel[],
  overlays: DocumentModel["overlays"],
): DocumentModel {
  return {
    pages: pages.map((page) => ({ ...page })),
    overlays,
  };
}

function highlight(pageId: string): DocumentModel["overlays"][number] {
  return {
    id: "h1",
    type: "highlight",
    pageId,
    rects: [{ x: 10, y: 10, w: 20, h: 12 }],
    color: "#f4d674",
    opacity: 0.45,
  };
}
