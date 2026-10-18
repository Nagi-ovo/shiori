import { describe, expect, test } from "bun:test";
import { placePageMenu, type PageMenuPlacement } from "./pageMenuPlacement";

const noInsets = { top: 0, right: 0, bottom: 0, left: 0 };

describe("page menu placement", () => {
  test("shrinks a context menu into an offset visual viewport and safe area", () => {
    const placement = placePageMenu(
      { kind: "point", x: 190, y: 180 },
      { width: 216, height: 220 },
      { left: 20, top: 30, width: 180, height: 160 },
      { top: 8, right: 6, bottom: 10, left: 4 },
    );

    expect(placement).toEqual({
      left: 32,
      top: 46,
      maxWidth: 154,
      maxHeight: 126,
    });
    expectInsideViewport(placement, 216, 220, {
      left: 32,
      top: 46,
      right: 186,
      bottom: 172,
    });
  });

  test("clamps a context menu against the right and bottom edges", () => {
    const placement = placePageMenu(
      { kind: "point", x: 790, y: 590 },
      { width: 216, height: 220 },
      { left: 0, top: 0, width: 800, height: 600 },
      noInsets,
    );

    expect(placement.left).toBe(576);
    expect(placement.top).toBe(372);
    expectInsideViewport(placement, 216, 220, {
      left: 8,
      top: 8,
      right: 792,
      bottom: 592,
    });
  });

  test("aligns a trigger menu to its right edge and flips above when needed", () => {
    const placement = placePageMenu(
      { kind: "trigger", left: 700, top: 550, right: 780, bottom: 582 },
      { width: 264, height: 120 },
      { left: 0, top: 0, width: 800, height: 600 },
      noInsets,
    );

    expect(placement.left).toBe(516);
    expect(placement.top).toBe(426);
    expectInsideViewport(placement, 264, 120, {
      left: 8,
      top: 8,
      right: 792,
      bottom: 592,
    });
  });

  test("keeps a trigger menu below when there is room", () => {
    const placement = placePageMenu(
      { kind: "trigger", left: 12, top: 12, right: 44, bottom: 44 },
      { width: 264, height: 120 },
      { left: 0, top: 0, width: 800, height: 600 },
      noInsets,
    );

    expect(placement.left).toBe(8);
    expect(placement.top).toBe(48);
    expectInsideViewport(placement, 264, 120, {
      left: 8,
      top: 8,
      right: 792,
      bottom: 592,
    });
  });

  test("places a trigger inside an offset visual viewport and safe area", () => {
    const placement = placePageMenu(
      { kind: "trigger", left: 260, top: 330, right: 292, bottom: 362 },
      { width: 264, height: 180 },
      { left: 100, top: 200, width: 320, height: 240 },
      { top: 12, right: 18, bottom: 16, left: 14 },
    );

    expect(placement).toEqual({
      left: 122,
      top: 220,
      maxWidth: 272,
      maxHeight: 196,
    });
    expectInsideViewport(placement, 264, 180, {
      left: 122,
      top: 220,
      right: 394,
      bottom: 416,
    });
  });
});

function expectInsideViewport(
  placement: PageMenuPlacement,
  naturalWidth: number,
  naturalHeight: number,
  bounds: { left: number; top: number; right: number; bottom: number },
) {
  const width = Math.min(naturalWidth, placement.maxWidth);
  const height = Math.min(naturalHeight, placement.maxHeight);
  expect(placement.left).toBeGreaterThanOrEqual(bounds.left);
  expect(placement.top).toBeGreaterThanOrEqual(bounds.top);
  expect(placement.left + width).toBeLessThanOrEqual(bounds.right);
  expect(placement.top + height).toBeLessThanOrEqual(bounds.bottom);
}
