import { describe, expect, test } from "bun:test";
import type { PageModel } from "../../pdf/model/types";
import {
  prepareThumbnailCanvas,
  thumbnailRotatedBoxPlacement,
  thumbnailViewportForPage,
  wrapThumbnailText,
} from "./thumbnailCompositor";

const blankPage: PageModel = {
  id: "blank",
  sourceIndex: -1,
  rotation: 0,
  widthPt: 400,
  heightPt: 200,
  blank: true,
};

describe("thumbnail compositor viewport", () => {
  test("uses actual blank page dimensions", () => {
    const viewport = thumbnailViewportForPage(blankPage, 100);

    expect(viewport.width).toBe(100);
    expect(viewport.scale).toBeCloseTo(0.25);
    expect(viewport.height).toBeCloseTo(50);
  });

  test("uses rotated page dimensions", () => {
    const viewport = thumbnailViewportForPage(
      { ...blankPage, rotation: 90 },
      100,
    );

    expect(viewport.width).toBe(100);
    expect(viewport.scale).toBeCloseTo(0.5);
    expect(viewport.height).toBeCloseTo(200);
  });

  test("keeps a rotated callout label's natural text box dimensions", () => {
    const placement = thumbnailRotatedBoxPlacement(
      { ...blankPage, rotation: 90 },
      { x: 20, y: 30, w: 100, h: 40 },
      0.5,
    );

    expect(placement.width).toBe(50);
    expect(placement.height).toBe(20);
    expect(placement.radians).toBeCloseTo(Math.PI / 2);
  });

  test("shrinks pathological thumbnail aspect ratios to the pixel budget", () => {
    const viewport = thumbnailViewportForPage(
      { ...blankPage, widthPt: 1, heightPt: 10_000 },
      100,
      10_000,
    );

    expect(viewport.width).toBeLessThan(100);
    expect(Math.ceil(viewport.width) * Math.ceil(viewport.height)).toBeLessThanOrEqual(
      10_000,
    );
  });

  test("keeps bitmap scale separate from tile CSS sizing", () => {
    const canvas = {
      width: 0,
      height: 0,
      style: { width: "", height: "" },
    } as HTMLCanvasElement;

    const viewport = prepareThumbnailCanvas(canvas, blankPage, 100, 2);

    expect(viewport.width).toBe(100);
    expect(viewport.height).toBeCloseTo(50);
    expect(canvas.width).toBe(200);
    expect(canvas.height).toBe(100);
    expect(canvas.style.width).toBe("100%");
    expect(canvas.style.height).toBe("100%");
  });

  test("uses the explicit DPR when shrinking thumbnails", () => {
    const canvas = {
      width: 0,
      height: 0,
      style: { width: "", height: "" },
    } as HTMLCanvasElement;

    const viewport = prepareThumbnailCanvas(
      canvas,
      { ...blankPage, widthPt: 1, heightPt: 10_000 },
      100,
      4,
    );

    expect(canvas.width * canvas.height).toBeLessThanOrEqual(1_000_000);
    expect(viewport.width).toBeLessThan(100);
  });

  test("wraps CJK and keeps grapheme clusters intact without canvas squashing", () => {
    const widthOf = (value: string) => Array.from(value).length;

    expect(wrapThumbnailText("批注文字继续", 2, widthOf)).toEqual([
      "批注",
      "文字",
      "继续",
    ]);
    expect(wrapThumbnailText("A\u0301B", 1, widthOf)).toEqual(["A\u0301", "B"]);
    expect(wrapThumbnailText("一二三四", 2, widthOf, 1)).toEqual(["一二"]);
  });
});
