import { describe, expect, test } from "bun:test";
import {
  documentTreeAnchors,
  documentTreeFolder,
  isPathInsideFolder,
} from "./documentTreeAnchors";
import type { Overlay, PageModel } from "../../pdf/model/types";

const pages: PageModel[] = [
  { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 },
  { id: "p2", sourceIndex: 1, rotation: 0, widthPt: 612, heightPt: 792 },
];

function note(id: string, overrides: Record<string, unknown> = {}): Overlay {
  return {
    type: "note",
    id,
    pageId: "p1",
    rect: { x: 0, y: 0, w: 10, h: 10 },
    text: "a remark",
    color: "#f4d674",
    ...overrides,
  } as unknown as Overlay;
}

describe("documentTreeAnchors", () => {
  test("lists marks in reading order with 1-based pages", () => {
    const anchors = documentTreeAnchors(
      [note("b", { pageId: "p2" }), note("a", { pageId: "p1" })],
      pages,
    );
    expect(anchors.map((anchor) => [anchor.id, anchor.page])).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });

  test("falls back to the anchored quote when there is no body", () => {
    const highlight = {
      type: "highlight",
      id: "h1",
      pageId: "p1",
      rects: [{ x: 0, y: 0, w: 10, h: 10 }],
      color: "#f4d674",
      opacity: 0.45,
      anchor: { quote: "  the bound   is tight ", page: 1 },
    } as unknown as Overlay;
    const [anchor] = documentTreeAnchors([highlight], pages);
    // Whitespace is flattened: a quote spanning a line break must still fit
    // one row without the break showing up as a gap.
    expect(anchor?.label).toBe("the bound is tight");
  });

  test("omits marks with nothing to show rather than drawing a blank row", () => {
    const ink = {
      type: "ink",
      id: "i1",
      pageId: "p1",
      points: [[{ x: 0, y: 0 }]],
      color: "#b13a2e",
      widthPt: 2,
    } as unknown as Overlay;
    expect(documentTreeAnchors([ink, note("n", { text: "  " })], pages)).toEqual(
      [],
    );
  });

  test("skips marks whose page is gone instead of guessing a number", () => {
    expect(documentTreeAnchors([note("x", { pageId: "deleted" })], pages)).toEqual(
      [],
    );
  });
});

describe("documentTreeFolder", () => {
  test("shows the containing folder, never the file name again", () => {
    // The title above this line already IS the file name; repeating it was
    // the original bug, along with the leading slash surfacing at the end.
    expect(documentTreeFolder("/Users/jesse/Downloads/paper.pdf")).toBe(
      "…/Downloads",
    );
  });

  test("drops the ellipsis when the folder is the whole path", () => {
    expect(documentTreeFolder("Downloads/paper.pdf")).toBe("Downloads");
  });

  test("handles Windows separators", () => {
    expect(documentTreeFolder("C:\\Users\\jesse\\Docs\\paper.pdf")).toBe(
      "…\\Docs",
    );
  });

  test("says nothing when there is no folder to name", () => {
    expect(documentTreeFolder(undefined)).toBeNull();
    expect(documentTreeFolder("paper.pdf")).toBeNull();
  });
});

describe("isPathInsideFolder", () => {
  test("matches a POSIX path under the mounted folder", () => {
    expect(isPathInsideFolder("/Users/jesse/Papers/a.pdf", "/Users/jesse/Papers"))
      .toBe(true);
    expect(isPathInsideFolder("/Users/jesse/Papers/sub/a.pdf", "/Users/jesse/Papers"))
      .toBe(true);
  });

  test("matches a Windows path — the separator is not always /", () => {
    // The regression: `path.startsWith(folder + "/")` is never true here, so
    // every file in a mounted folder was also listed under "unfiled".
    expect(isPathInsideFolder("C:\\Papers\\a.pdf", "C:\\Papers")).toBe(true);
    expect(isPathInsideFolder("C:\\Papers\\Sub\\a.pdf", "C:\\Papers")).toBe(true);
    expect(isPathInsideFolder("C:\\papers\\a.pdf", "C:\\Papers")).toBe(true);
  });

  test("a backslash in a POSIX filename is not a separator", () => {
    // Legal on macOS/Linux: the file is named `Papers\Archive`, it is not a
    // path into a `Papers` directory.
    expect(
      isPathInsideFolder("/tmp/Papers\\Archive/a.pdf", "/tmp/Papers"),
    ).toBe(false);
  });

  test("handles UNC shares and a drive root", () => {
    expect(
      isPathInsideFolder("\\\\server\\share\\a.pdf", "\\\\server\\share"),
    ).toBe(true);
    expect(isPathInsideFolder("C:\\a.pdf", "C:\\")).toBe(true);
    expect(isPathInsideFolder("C:\\Papers\\a.pdf", "C:\\Papers\\")).toBe(true);
  });

  test("does not match a sibling folder that shares a name prefix", () => {
    expect(isPathInsideFolder("/Users/jesse/Papers2/a.pdf", "/Users/jesse/Papers"))
      .toBe(false);
    expect(isPathInsideFolder("C:\\Papers2\\a.pdf", "C:\\Papers")).toBe(false);
  });

  test("the folder is not inside itself, and nothing is inside nothing", () => {
    expect(isPathInsideFolder("/Users/jesse/Papers", "/Users/jesse/Papers")).toBe(
      false,
    );
    expect(isPathInsideFolder(undefined, "/Users/jesse/Papers")).toBe(false);
    expect(isPathInsideFolder("/Users/jesse/Papers/a.pdf", undefined)).toBe(false);
  });
});
