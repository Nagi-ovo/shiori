import { describe, expect, test } from "bun:test";
import type { Overlay } from "../../pdf/model/types";
import { applyHighlightGesture } from "./merge";

describe("text markup merge gestures", () => {
  test("re-marking same-color text removes the covered interval", () => {
    const result = applyHighlightGesture({
      overlays: [
        highlight("old", "#f4d674", [{ x: 10, y: 20, w: 100, h: 12 }]),
      ],
      pageId: "p1",
      rects: [{ x: 40, y: 20, w: 30, h: 12 }],
      color: "#f4d674",
      opacity: 0.45,
      makeId: () => "new",
    });

    expect(result.selectedId).toBeNull();
    expect(result.overlays).toEqual([
      highlight("old", "#f4d674", [
        { x: 10, y: 20, w: 30, h: 12 },
        { x: 70, y: 20, w: 40, h: 12 },
      ]),
    ]);
  });

  test("different-color highlights replace the overlapped interval", () => {
    const result = applyHighlightGesture({
      overlays: [
        highlight("old", "#f4d674", [{ x: 10, y: 20, w: 100, h: 12 }]),
      ],
      pageId: "p1",
      rects: [{ x: 40, y: 20, w: 30, h: 12 }],
      color: "#f4a57f",
      opacity: 0.45,
      makeId: () => "new",
    });

    expect(result.selectedId).toBe("new");
    expect(result.overlays).toEqual([
      highlight("old", "#f4d674", [
        { x: 10, y: 20, w: 30, h: 12 },
        { x: 70, y: 20, w: 40, h: 12 },
      ]),
      highlight("new", "#f4a57f", [{ x: 40, y: 20, w: 30, h: 12 }]),
    ]);
  });

  test("different-color underlines use the same non-overlap rules", () => {
    const result = applyHighlightGesture({
      type: "underline",
      overlays: [
        underline("old", "#b13a2e", [{ x: 10, y: 20, w: 100, h: 12 }]),
      ],
      pageId: "p1",
      rects: [{ x: 60, y: 20, w: 60, h: 12 }],
      color: "#2f5a8a",
      opacity: 1,
      makeId: () => "new",
    });

    expect(result.selectedId).toBe("new");
    expect(result.overlays).toEqual([
      underline("old", "#b13a2e", [{ x: 10, y: 20, w: 50, h: 12 }]),
      underline("new", "#2f5a8a", [{ x: 60, y: 20, w: 60, h: 12 }]),
    ]);
  });

  test("different-color strikethroughs use the same non-overlap rules", () => {
    const result = applyHighlightGesture({
      type: "strikethrough",
      overlays: [
        strikethrough("old", "#b13a2e", [{ x: 10, y: 20, w: 100, h: 12 }]),
      ],
      pageId: "p1",
      rects: [{ x: 60, y: 20, w: 60, h: 12 }],
      color: "#2f5a8a",
      opacity: 1,
      makeId: () => "new",
    });

    expect(result.selectedId).toBe("new");
    expect(result.overlays).toEqual([
      strikethrough("old", "#b13a2e", [{ x: 10, y: 20, w: 50, h: 12 }]),
      strikethrough("new", "#2f5a8a", [{ x: 60, y: 20, w: 60, h: 12 }]),
    ]);
  });
});

describe("anchor provenance through markup gestures", () => {
  const anchor = { quote: "quoted text", page: 1 };

  test("a stand-alone gesture carries its selection anchor", () => {
    const result = applyHighlightGesture({
      overlays: [],
      pageId: "p1",
      rects: [{ x: 40, y: 20, w: 30, h: 12 }],
      color: "#f4d674",
      opacity: 0.45,
      makeId: () => "new",
      anchor,
    });
    expect(result.overlays).toHaveLength(1);
    expect(result.overlays[0]?.anchor).toEqual(anchor);
  });

  test("a merged gesture drops both its own and the absorbed anchor", () => {
    const absorbed = {
      ...highlight("old", "#f4d674", [{ x: 10, y: 20, w: 40, h: 12 }]),
      anchor: { quote: "older words", page: 1, occurrence: 1 },
    };
    const result = applyHighlightGesture({
      overlays: [absorbed],
      pageId: "p1",
      // Touches the existing highlight, extending rather than erasing.
      rects: [{ x: 45, y: 20, w: 60, h: 12 }],
      color: "#f4d674",
      opacity: 0.45,
      makeId: () => "new",
      anchor,
    });
    expect(result.selectedId).toBe("new");
    expect(result.overlays).toHaveLength(1);
    // The merged markup spans more text than either provenance claims.
    expect(result.overlays[0]?.anchor).toBeUndefined();
  });

  test("erasing part of an anchored markup strips its anchor", () => {
    const anchored = {
      ...highlight("old", "#f4d674", [{ x: 10, y: 20, w: 100, h: 12 }]),
      anchor: { quote: "the whole covered sentence", page: 1, occurrence: 2 },
    };
    const result = applyHighlightGesture({
      overlays: [anchored],
      pageId: "p1",
      rects: [{ x: 40, y: 20, w: 30, h: 12 }],
      color: "#f4d674",
      opacity: 0.45,
      makeId: () => "new",
    });
    expect(result.changed).toBe(true);
    expect(result.overlays).toHaveLength(1);
    expect(result.overlays[0]?.anchor).toBeUndefined();
  });

  test("a different-color overlap strips the reshaped overlay's anchor", () => {
    const anchored = {
      ...highlight("old", "#f4d674", [{ x: 10, y: 20, w: 100, h: 12 }]),
      anchor: { quote: "the whole covered sentence", page: 1 },
    };
    const result = applyHighlightGesture({
      overlays: [anchored],
      pageId: "p1",
      rects: [{ x: 40, y: 20, w: 30, h: 12 }],
      color: "#f4a57f",
      opacity: 0.45,
      makeId: () => "new",
      anchor,
    });
    const reshaped = result.overlays.find((o) => o.id === "old");
    const created = result.overlays.find((o) => o.id === "new");
    expect(reshaped?.anchor).toBeUndefined();
    // The new markup did not merge with same-color neighbours, so its own
    // anchor is honest and survives.
    expect(created?.anchor).toEqual(anchor);
  });
});

describe("imported review provenance through markup gestures", () => {
  test("does not absorb a same-color imported highlight into a new id", () => {
    const imported = {
      ...highlight("imported", "#f4d674", [
        { x: 10, y: 20, w: 40, h: 12 },
      ]),
      sourceAuthor: "Jane Chen",
      sourceCreatedAt: 1,
    };
    const result = applyHighlightGesture({
      overlays: [imported],
      pageId: "p1",
      rects: [{ x: 45, y: 20, w: 40, h: 12 }],
      color: "#f4d674",
      opacity: 0.45,
      makeId: () => "new",
    });

    expect(result.overlays.find((overlay) => overlay.id === "imported")).toEqual(
      imported,
    );
    expect(result.overlays.find((overlay) => overlay.id === "new")).toBeDefined();
  });

  test("does not reshape an imported highlight during color replacement", () => {
    const imported = {
      ...highlight("imported", "#f4d674", [
        { x: 10, y: 20, w: 100, h: 12 },
      ]),
      sourceInReplyToId: "parent",
      sourceReplyType: "R" as const,
    };
    const result = applyHighlightGesture({
      overlays: [imported],
      pageId: "p1",
      rects: [{ x: 40, y: 20, w: 30, h: 12 }],
      color: "#f4a57f",
      opacity: 0.45,
      makeId: () => "new",
    });

    expect(result.overlays.find((overlay) => overlay.id === "imported")).toEqual(
      imported,
    );
    expect(result.overlays.find((overlay) => overlay.id === "new")).toBeDefined();
  });
});

function highlight(
  id: string,
  color: string,
  rects: Array<{ x: number; y: number; w: number; h: number }>,
): Overlay {
  return {
    type: "highlight",
    id,
    pageId: "p1",
    rects,
    color,
    opacity: 0.45,
  };
}

function underline(
  id: string,
  color: string,
  rects: Array<{ x: number; y: number; w: number; h: number }>,
): Overlay {
  return {
    type: "underline",
    id,
    pageId: "p1",
    rects,
    color,
    opacity: 1,
  };
}

function strikethrough(
  id: string,
  color: string,
  rects: Array<{ x: number; y: number; w: number; h: number }>,
): Overlay {
  return {
    type: "strikethrough",
    id,
    pageId: "p1",
    rects,
    color,
    opacity: 1,
  };
}

test("marking the next tiny glyph does not erase its neighbour", () => {
  const result = applyHighlightGesture({
    overlays: [highlight("old", "#f4d674", [{ x: 10, y: 20, w: 0.2, h: 2 }])],
    pageId: "p1", rects: [{ x: 10.2, y: 20, w: 0.2, h: 2 }],
    color: "#f4d674", opacity: 0.45, makeId: () => "new",
  });
  expect(result.overlays).toEqual([highlight("new", "#f4d674", [{ x: 10, y: 20, w: 0.4, h: 2 }])]);
});
