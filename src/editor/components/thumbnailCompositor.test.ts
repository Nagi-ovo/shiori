import { describe, expect, test } from "bun:test";
import type { Overlay, PageModel } from "../../pdf/model/types";
import {
  drawThumbnailOverlays,
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

// The editor turns a box clockwise about its center by its free angle, on top
// of the page's rotation (OverlayDom boxPlacement). Thumbnails and Compact
// export paint through this compositor, so they must show the same turn.
describe("thumbnail compositor free rotation", () => {
  const page: PageModel = { ...blankPage, widthPt: 400, heightPt: 300 };
  const rect = { x: 100, y: 120, w: 80, h: 40 };
  const boxes: Overlay[] = [
    { type: "rect", id: "r", pageId: "blank", rect, color: "#000", strokeWidth: 2, fill: "#eee" },
    { type: "stamp", id: "s", pageId: "blank", kind: "check", rect, color: "#000", strokeWidth: 2 },
    { type: "note", id: "n", pageId: "blank", rect, text: "x", color: "#ff0" },
    {
      type: "text", id: "t", pageId: "blank", rect, text: "Rotate me", fontSize: 12,
      color: "#000", bold: false, align: "left", fontFamily: "sans",
    },
  ];

  for (const rotation of [0, 90] as const) {
    for (const box of boxes) {
      test(`turns a ${box.type} by its angle on a ${rotation}° page`, () => {
        const onPage = { ...page, rotation };
        const flat = drawnPoints(onPage, { ...box, angle: 0 } as Overlay);
        const turned = drawnPoints(onPage, { ...box, angle: 30 } as Overlay);
        const c = displayCenter(onPage, rect);
        expect(flat.length).toBeGreaterThan(0);
        expect(turned.length).toBe(flat.length);
        turned.forEach((point, i) => {
          const expected = turnClockwise(flat[i]!, c, 30);
          expect(point.x).toBeCloseTo(expected.x, 6);
          expect(point.y).toBeCloseTo(expected.y, 6);
        });
      });
    }
  }

  test("turns clockwise: a left-aligned box at 90° starts its text top-right", () => {
    const text = boxes[3]!;
    const scale = 1;
    const [origin] = drawnPoints(page, { ...text, angle: 90 } as Overlay, "fillText");
    const c = displayCenter(page, rect);
    const pad = 3 * scale;
    // The box's top-left corner (where the first line starts) goes to the
    // top-right under a clockwise quarter turn.
    expect(origin!.x).toBeCloseTo(c.x + rect.h / 2 - pad, 6);
    expect(origin!.y).toBeCloseTo(c.y - rect.w / 2 + pad, 6);
  });
});

type Point = { x: number; y: number };

function displayCenter(page: PageModel, rect: { x: number; y: number; w: number; h: number }): Point {
  const p = thumbnailRotatedBoxPlacement(page, rect, 1);
  return { x: p.centerX, y: p.centerY };
}

function turnClockwise(p: Point, c: Point, degrees: number): Point {
  const r = (degrees * Math.PI) / 180;
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  return { x: c.x + dx * Math.cos(r) - dy * Math.sin(r), y: c.y + dx * Math.sin(r) + dy * Math.cos(r) };
}

/**
 * Paints one overlay at scale 1 into a context that tracks the current
 * transform, and returns every point it drew, in canvas pixels. The
 * compositor's own clip to the whole tile is left out.
 */
function drawnPoints(page: PageModel, overlay: Overlay, only?: string): Point[] {
  const viewport = { width: page.widthPt, height: page.heightPt, scale: 1 };
  if (page.rotation === 90 || page.rotation === 270) {
    viewport.width = page.heightPt;
    viewport.height = page.widthPt;
  }
  type M = [number, number, number, number, number, number];
  let m: M = [1, 0, 0, 1, 0, 0];
  const stack: M[] = [];
  const points: Point[] = [];
  const at = (x: number, y: number) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });
  const record = (name: string, ...xy: number[]) => {
    if (only && name !== only) return;
    for (let i = 0; i + 1 < xy.length; i += 2) points.push(at(xy[i]!, xy[i + 1]!));
  };
  const box = (name: string, x: number, y: number, w: number, h: number) =>
    record(name, x, y, x + w, y, x + w, y + h, x, y + h);
  const multiply = (n: M) => {
    m = [
      m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
    ];
  };
  const methods: Record<string, (...args: never[]) => unknown> = {
    save: () => stack.push(m),
    restore: () => { m = stack.pop() ?? m; },
    setTransform: (...n: number[]) => { m = n as M; },
    translate: (x: number, y: number) => multiply([1, 0, 0, 1, x, y]),
    rotate: (r: number) => multiply([Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]),
    scale: (x: number, y: number) => multiply([x, 0, 0, y, 0, 0]),
    moveTo: (x: number, y: number) => record("moveTo", x, y),
    lineTo: (x: number, y: number) => record("lineTo", x, y),
    quadraticCurveTo: (a: number, b: number, x: number, y: number) => record("quadraticCurveTo", a, b, x, y),
    rect: (x: number, y: number, w: number, h: number) => {
      if (x === 0 && y === 0 && w === viewport.width && h === viewport.height) return;
      box("rect", x, y, w, h);
    },
    fillRect: (x: number, y: number, w: number, h: number) => box("fillRect", x, y, w, h),
    fillText: (_text: string, x: number, y: number) => record("fillText", x, y),
    measureText: (text: string) => ({ width: text.length * 6 }),
  };
  const state: Record<string, unknown> = { canvas: { width: viewport.width } };
  const ctx = new Proxy(state, {
    get: (target, key) => (typeof key === "string" && key in methods ? methods[key] : target[key as string] ?? (() => undefined)),
    set: (target, key, value) => {
      target[key as string] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  drawThumbnailOverlays(ctx, page, [overlay], viewport);
  return points;
}
