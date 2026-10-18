import { describe, expect, test } from "bun:test";
import type { Overlay } from "../../pdf/model/types";
import { copySelectedOverlays, pasteOverlays } from "./clipboard";

describe("overlay clipboard helpers", () => {
  test("copies selected overlays in document order without sharing geometry", () => {
    const overlays = sampleOverlays();
    const copied = copySelectedOverlays(overlays, ["i", "r", "s"]);

    expect(copied.map((o) => o.id)).toEqual(["r", "i", "s"]);
    if (copied[0]?.type !== "rect" || overlays[0]?.type !== "rect") {
      throw new Error("expected rect sample");
    }
    copied[0].rect.x = 99;
    expect(overlays[0].rect.x).toBe(10);
    if (copied[2]?.type !== "stamp" || overlays[3]?.type !== "stamp") {
      throw new Error("expected stamp sample");
    }
    copied[2].rect.x = 88;
    expect(overlays[3].rect.x).toBe(12);
  });

  test("pastes overlays onto the active page with fresh ids and offsets", () => {
    const pasted = pasteOverlays(
      copySelectedOverlays(sampleOverlays(), ["n"]),
      "target",
      () => "copy",
      1234,
    );

    expect(pasted).toEqual([
      {
        type: "note",
        id: "copy",
        pageId: "target",
        rect: { x: 17, y: 3, w: 40, h: 20 },
        text: "note",
        color: "#f7e9a8",
        createdAt: 1234,
        updatedAt: 1234,
      },
    ]);
  });

  test("a pasted replica does not inherit text-anchor provenance", () => {
    const anchored: Overlay[] = [
      {
        type: "highlight",
        id: "h",
        pageId: "p1",
        rects: [{ x: 10, y: 20, w: 30, h: 12 }],
        color: "#f6c744",
        opacity: 0.35,
        anchor: { quote: "quoted text", page: 1, occurrence: 1 },
      },
    ];
    const pasted = pasteOverlays(
      copySelectedOverlays(anchored, ["h"]),
      "target",
      () => "copy",
      1234,
    );
    expect(pasted).toHaveLength(1);
    // The copy no longer sits on the anchored text; carrying the anchor
    // over would be provenance for a location the replica is not at.
    expect(pasted[0]?.anchor).toBeUndefined();
  });
});

function sampleOverlays(): Overlay[] {
  return [
    {
      type: "rect",
      id: "r",
      pageId: "p1",
      rect: { x: 10, y: 20, w: 30, h: 12 },
      color: "#b13a2e",
      strokeWidth: 2,
      fill: null,
    },
    {
      type: "note",
      id: "n",
      pageId: "p1",
      rect: { x: 5, y: 15, w: 40, h: 20 },
      text: "note",
      color: "#f7e9a8",
      createdAt: 100,
      updatedAt: 200,
    },
    {
      type: "ink",
      id: "i",
      pageId: "p2",
      paths: [[{ x: 1, y: 2 }]],
      color: "#111111",
      width: 2,
    },
    {
      type: "stamp",
      id: "s",
      pageId: "p2",
      kind: "check",
      rect: { x: 12, y: 24, w: 14, h: 14 },
      color: "#1a1815",
      strokeWidth: 1.8,
    },
  ];
}

// Pinned semantics: contentText edits redact the exact glyphs under their
// covers, so a pasted/offset copy would excise unrelated text. They never
// enter the clipboard, from either direction.
const CONTENT_TEXT: Overlay = {
  type: "contentText",
  id: "ct",
  pageId: "p0",
  rect: { x: 18, y: 20, w: 70, h: 20 },
  coverRects: [{ x: 20, y: 30, w: 64, h: 12 }],
  sourceBaselinesPt: [38, 26],
  originalText: "old",
  text: "new",
  fontSize: 12,
  color: "#111111",
  bold: false,
  align: "left",
  fontFamily: "sans",
  backgroundColor: "#ffffff",
};

describe("contentText pinning", () => {
  test("copy excludes contentText edits", () => {
    expect(copySelectedOverlays([CONTENT_TEXT], ["ct"])).toEqual([]);
  });

  test("paste drops contentText from stale clipboard state", () => {
    expect(pasteOverlays([CONTENT_TEXT], "target", () => "copy")).toEqual([]);
  });
});
