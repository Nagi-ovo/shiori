import { describe, expect, test } from "bun:test";
import { coalescePdfRects } from "./rectCoalesce";

describe("PDF rect coalescing", () => {
  test("preserves the individual heights of overlapping text runs", () => {
    expect(
      coalescePdfRects([
        { x: 10, y: 20, w: 70, h: 20 },
        { x: 75, y: 22, w: 75, h: 20 },
      ]),
    ).toEqual([{ x: 75, y: 22, w: 75, h: 20 }, { x: 10, y: 20, w: 70, h: 20 }]);
  });

  test("keeps separate text lines apart", () => {
    expect(
      coalescePdfRects([
        { x: 10, y: 50, w: 70, h: 12 },
        { x: 10, y: 20, w: 70, h: 12 },
      ]),
    ).toEqual([
      { x: 10, y: 50, w: 70, h: 12 },
      { x: 10, y: 20, w: 70, h: 12 },
    ]);
  });
});

 test("keeps disconnected columns and a superscript at their original height", () => {
  const rects = [{ x: 10, y: 20, w: 70, h: 20 }, { x: 250, y: 24, w: 40, h: 12 }];
  expect(coalescePdfRects(rects)).toEqual([rects[1]!, rects[0]!]);
 });
 test("preserves a visible narrow glyph below a quarter point", () => {
  expect(coalescePdfRects([{ x: 10, y: 20, w: 0.2, h: 2 }])).toEqual([{ x: 10, y: 20, w: 0.2, h: 2 }]);
 });
