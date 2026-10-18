import { describe, expect, test } from "bun:test";
import type { PageModel } from "../model/types";
import { reconcilePdfPageInsertion } from "./insertPageModels";

describe("reconcilePdfPageInsertion", () => {
  test("keeps base IDs and gives inserted pages the new source-index range", () => {
    const previousPages: PageModel[] = [
      page("first", 4),
      page("blank", -1, true),
      page("last", 1),
    ];
    let nextId = 0;

    const result = reconcilePdfPageInsertion({
      previousPages,
      outputGeometry: [300, 200, 210, 612, 500].map((widthPt) => ({
        rotation: 0 as const,
        originXPt: 0,
        originYPt: 0,
        widthPt,
        heightPt: 700,
      })),
      insertionIndex: 1,
      insertedPageCount: 2,
      createId: () => `new-${++nextId}`,
    });

    expect(result.pages.map((item) => item.id)).toEqual([
      "first",
      "new-1",
      "new-2",
      "blank",
      "last",
    ]);
    expect(result.pages.map((item) => item.sourceIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(result.insertedPages.map((item) => item.id)).toEqual(["new-1", "new-2"]);
    expect(result.basePages.map((item) => item.id)).toEqual([
      "first",
      "blank",
      "last",
    ]);
    expect(result.baseOutputSourceIndices).toEqual([0, 3, 4]);
    // A serialized blank page is now a normal source page; carrying `blank`
    // would make the next export create another empty page instead of copying
    // the one now present in the merged bytes.
    expect(result.basePages[1]?.blank).toBeUndefined();
  });

  test("rejects a layout that cannot correspond to the requested insertion", () => {
    expect(() =>
      reconcilePdfPageInsertion({
        previousPages: [page("only", 0)],
        outputGeometry: [],
        insertionIndex: 1,
        insertedPageCount: 1,
        createId: () => "new",
      }),
    ).toThrow("page-layout-mismatch");
  });
});

function page(id: string, sourceIndex: number, blank = false): PageModel {
  return {
    id,
    sourceIndex,
    rotation: 0,
    widthPt: 612,
    heightPt: 792,
    ...(blank ? { blank: true } : {}),
  };
}
