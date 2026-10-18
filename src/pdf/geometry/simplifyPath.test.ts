import { describe, expect, test } from "bun:test";
import {
  compactInkPath,
  quantizePath,
  simplifyPathRDP,
  type SimplePoint,
} from "./simplifyPath";

describe("simplifyPathRDP", () => {
  test("collapses collinear points to the endpoints", () => {
    const straight: SimplePoint[] = Array.from({ length: 50 }, (_, i) => ({
      x: i,
      y: 0,
    }));
    const simplified = simplifyPathRDP(straight, 0.4);
    expect(simplified).toEqual([
      { x: 0, y: 0 },
      { x: 49, y: 0 },
    ]);
  });

  test("keeps points that carry the shape's corners", () => {
    // An L: 0,0 → 10,0 → 10,10 with dense collinear fill on each leg.
    const points: SimplePoint[] = [];
    for (let x = 0; x <= 10; x += 0.5) points.push({ x, y: 0 });
    for (let y = 0.5; y <= 10; y += 0.5) points.push({ x: 10, y });
    const simplified = simplifyPathRDP(points, 0.4);
    expect(simplified).toContainEqual({ x: 0, y: 0 });
    expect(simplified).toContainEqual({ x: 10, y: 0 });
    expect(simplified).toContainEqual({ x: 10, y: 10 });
    // The corner is retained but the collinear fill is gone.
    expect(simplified.length).toBeLessThan(8);
  });

  test("preserves a genuine curve within epsilon tolerance", () => {
    const arc: SimplePoint[] = Array.from({ length: 100 }, (_, i) => {
      const t = (i / 99) * Math.PI;
      return { x: Math.cos(t) * 50, y: Math.sin(t) * 50 };
    });
    const simplified = simplifyPathRDP(arc, 0.4);
    // Fewer points than the input, but enough to keep the arc smooth.
    expect(simplified.length).toBeLessThan(arc.length);
    expect(simplified.length).toBeGreaterThan(8);
    // Every dropped point stays within epsilon of the retained polyline —
    // spot check the apex is preserved.
    expect(simplified.some((p) => Math.abs(p.y - 50) < 1)).toBe(true);
  });

  test("returns a copy for degenerate inputs", () => {
    expect(simplifyPathRDP([], 0.4)).toEqual([]);
    const single = [{ x: 1, y: 2 }];
    const out = simplifyPathRDP(single, 0.4);
    expect(out).toEqual(single);
    expect(out).not.toBe(single);
  });

  test("epsilon <= 0 is a no-op copy", () => {
    const points: SimplePoint[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0.1 },
      { x: 2, y: 0 },
    ];
    expect(simplifyPathRDP(points, 0)).toEqual(points);
  });
});

describe("quantizePath", () => {
  test("trims the float64 long tail", () => {
    expect(quantizePath([{ x: 640.4000000000001, y: 12.3456 }])).toEqual([
      { x: 640.4, y: 12.35 },
    ]);
  });
});

describe("compactInkPath", () => {
  test("simplifies then quantizes a dense stroke", () => {
    const dense: SimplePoint[] = Array.from({ length: 200 }, (_, i) => ({
      x: i * 0.3333333,
      y: 0,
    }));
    const out = compactInkPath(dense);
    expect(out.length).toBeLessThan(dense.length);
    // Quantized to 2 decimals.
    for (const p of out) {
      expect(p.x).toBe(Math.round(p.x * 100) / 100);
    }
  });
});
