import { describe, expect, test } from "bun:test";
import { constrainInkPoint } from "./ink";

describe("ink helpers", () => {
  test("snaps a point to the nearest straight-line direction", () => {
    expect(constrainInkPoint({ x: 0, y: 0 }, { x: 10, y: 2 })).toEqual({
      x: Math.hypot(10, 2),
      y: 0,
    });

    const diagonal = constrainInkPoint({ x: 1, y: 1 }, { x: 7, y: 9 });
    expect(Math.round(diagonal.x * 100) / 100).toBe(8.07);
    expect(Math.round(diagonal.y * 100) / 100).toBe(8.07);
  });
});
