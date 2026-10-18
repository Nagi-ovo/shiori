import { describe, expect, test } from "bun:test";
import { effectivePdfPageBox } from "./pageBoxes";

describe("effectivePdfPageBox", () => {
  test("intersects an out-of-bounds CropBox like pdf.js page.view", () => {
    expect(
      effectivePdfPageBox(
        { x: 0, y: 0, width: 600, height: 800 },
        { x: -50, y: -100, width: 700, height: 900 },
      ),
    ).toEqual({ x: 0, y: 0, width: 600, height: 800 });
  });

  test("keeps a valid CropBox and falls back to MediaBox when disjoint", () => {
    expect(
      effectivePdfPageBox(
        { x: 0, y: 0, width: 600, height: 800 },
        { x: 50, y: 100, width: 300, height: 400 },
      ),
    ).toEqual({ x: 50, y: 100, width: 300, height: 400 });
    expect(
      effectivePdfPageBox(
        { x: 0, y: 0, width: 600, height: 800 },
        { x: 700, y: 900, width: 10, height: 10 },
      ),
    ).toEqual({ x: 0, y: 0, width: 600, height: 800 });
  });

  test("uses PDF.js' Letter fallback before intersecting an invalid MediaBox", () => {
    expect(
      effectivePdfPageBox(
        { x: Number.NaN, y: 0, width: 600, height: 800 },
        { x: 700, y: 900, width: 300, height: 300 },
      ),
    ).toEqual({ x: 0, y: 0, width: 612, height: 792 });
    expect(
      effectivePdfPageBox(
        { x: 0, y: 0, width: 0, height: 0 },
        { x: 100, y: 100, width: 700, height: 800 },
      ),
    ).toEqual({ x: 100, y: 100, width: 512, height: 692 });
  });
});
