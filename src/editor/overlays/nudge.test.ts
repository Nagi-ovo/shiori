import { describe, expect, test } from "bun:test";
import type { Overlay, PageModel, Rotation } from "../../pdf/model/types";
import { pdfRectToDisplay } from "../../pdf/geometry/coords";
import { nudgeOverlays } from "./nudge";

describe("overlay nudging", () => {
  test("moves selected overlays in visual arrow-key directions", () => {
    const pages: PageModel[] = [
      { id: "p0", sourceIndex: 0, widthPt: 100, heightPt: 200, rotation: 0 },
      { id: "p90", sourceIndex: 1, widthPt: 100, heightPt: 200, rotation: 90 },
    ];
    const overlays = sampleOverlays();

    const nudged = nudgeOverlays(overlays, ["a", "b"], pages, 0, -10);

    // Unrotated page: display-up is PDF +y, so the rect rises 10pt.
    expect(nudged[0]).toMatchObject({
      rect: { x: 10, y: 30, w: 20, h: 10 },
    });
    // Rotated 90°, pdf.js maps PDF (x, y) to display (y, x), so display-y IS
    // PDF-x. Arrow-up must therefore DECREASE PDF x. (This expectation read
    // `x: 20` while coords.ts had 90/270 swapped — i.e. arrow-up drove the
    // overlay down the screen.)
    expect(nudged[1]).toMatchObject({
      rect: { x: 0, y: 30, w: 20, h: 10 },
    });
    expect(nudged[2]).toBe(overlays[2]);
  });

  // The invariant users actually feel: whatever the page rotation, pressing an
  // arrow key moves the overlay that way ON SCREEN. Asserting in display space
  // keeps this honest — a future coords.ts change that flips a rotation branch
  // fails here instead of silently mirroring people's annotations.
  test("arrow keys move overlays the same visual way on every rotation", () => {
    const STEP = 10;
    const directions = [
      { name: "up", dx: 0, dy: -STEP },
      { name: "down", dx: 0, dy: STEP },
      { name: "left", dx: -STEP, dy: 0 },
      { name: "right", dx: STEP, dy: 0 },
    ];

    for (const rotation of [0, 90, 180, 270] as Rotation[]) {
      const page: PageModel = {
        id: "p",
        sourceIndex: 0,
        widthPt: 100,
        heightPt: 200,
        rotation,
      };
      const overlay: Overlay = {
        type: "rect",
        id: "a",
        pageId: "p",
        rect: { x: 30, y: 60, w: 20, h: 10 },
        color: "#111111",
        strokeWidth: 2,
        fill: null,
      };

      for (const dir of directions) {
        const moved = nudgeOverlays([overlay], ["a"], [page], dir.dx, dir.dy);
        const before = pdfRectToDisplay(
          overlay.rect,
          page.widthPt,
          page.heightPt,
          rotation,
          1,
        );
        const after = pdfRectToDisplay(
          (moved[0] as Extract<Overlay, { type: "rect" }>).rect,
          page.widthPt,
          page.heightPt,
          rotation,
          1,
        );

        expect(
          `${rotation}/${dir.name}/x:${(after.x - before.x).toFixed(3)}`,
        ).toBe(`${rotation}/${dir.name}/x:${dir.dx.toFixed(3)}`);
        expect(
          `${rotation}/${dir.name}/y:${(after.y - before.y).toFixed(3)}`,
        ).toBe(`${rotation}/${dir.name}/y:${dir.dy.toFixed(3)}`);
      }
    }
  });

  test("does not move locked overlays", () => {
    const page: PageModel = {
      id: "p0",
      sourceIndex: 0,
      widthPt: 100,
      heightPt: 200,
      rotation: 0,
    };
    const overlays = sampleOverlays();
    overlays[0] = { ...overlays[0]!, locked: true };

    expect(nudgeOverlays(overlays, ["a"], [page], 0, -10)[0]).toBe(overlays[0]);
  });
});

function sampleOverlays(): Overlay[] {
  return [
    {
      type: "rect",
      id: "a",
      pageId: "p0",
      rect: { x: 10, y: 20, w: 20, h: 10 },
      color: "#111111",
      strokeWidth: 2,
      fill: null,
    },
    {
      type: "rect",
      id: "b",
      pageId: "p90",
      rect: { x: 10, y: 30, w: 20, h: 10 },
      color: "#111111",
      strokeWidth: 2,
      fill: null,
    },
    {
      type: "ink",
      id: "c",
      pageId: "p0",
      paths: [[{ x: 1, y: 2 }]],
      color: "#111111",
      width: 2,
    },
  ];
}

// Pinned semantics: a contentText edit redacts the exact glyphs under its
// covers, so no gesture may translate it (matches OverlayLayer's move
// guard). A nudge that slipped through would shift the covers while the
// absolute baselines kept the text in place — corrupting the export.
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
  test("nudging never moves a contentText edit", () => {
    const page: PageModel = {
      id: "p0",
      sourceIndex: 0,
      widthPt: 100,
      heightPt: 200,
      rotation: 0,
    };
    const overlays: Overlay[] = [CONTENT_TEXT];
    expect(nudgeOverlays(overlays, ["ct"], [page], 0, -10)[0]).toBe(
      CONTENT_TEXT,
    );
  });
});
