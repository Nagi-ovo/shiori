import { describe, expect, test } from "bun:test";
import { tabOutlinePaths } from "./tabOutlineGeometry";

// Endpoints of every segment, in order. A path here is only M, L, A and Z;
// an arc's endpoint is its last two numbers.
function points(d: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const segment of d.match(/[MLAZ][^MLAZ]*/g) ?? []) {
    const nums = segment.slice(1).trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (nums.length >= 2) out.push([nums[nums.length - 2]!, nums[nums.length - 1]!]);
  }
  return out;
}

// The SVG spans the tab plus one foot on each side, and the tab's full
// height: 120px tab → 134px box at foot 7.
const W = 134;
const H = 34;

describe("tabOutlinePaths", () => {
  test("draws nothing before the tab has a size", () => {
    for (const [w, h] of [[0, 34], [134, 0], [-5, 34], [Number.NaN, 34], [134, Number.POSITIVE_INFINITY]]) {
      expect(tabOutlinePaths(w!, h!, 7, 7)).toEqual({ fill: "", stroke: "" });
    }
  });

  test("puts the stroke on the half-pixel centres of the tab's 1px edges", () => {
    const pts = points(tabOutlinePaths(W, H, 7, 7).stroke);
    const xs = pts.map(([x]) => x);
    const ys = pts.map(([, y]) => y);
    // Left and right sides sit on the tab's own edge columns.
    expect(xs).toContain(7.5);
    expect(xs).toContain(W - 7.5);
    // The top runs along the tab's first row.
    expect(Math.min(...ys)).toBe(0.5);
  });

  test("lands both feet tangent on the strip's 1px baseline row", () => {
    const pts = points(tabOutlinePaths(W, H, 7, 7).stroke);
    const first = pts[0]!;
    const last = pts[pts.length - 1]!;
    expect(first[1]).toBe(H - 0.5);
    expect(last[1]).toBe(H - 0.5);
    // Inside the box, a foot's radius out from the tab's edge.
    expect(first[0]).toBeGreaterThanOrEqual(0);
    expect(last[0]).toBeLessThanOrEqual(W);
    expect(first[0]).toBe(7.5 - 6.5);
  });

  test("mirrors left and right at a fractional width", () => {
    const w = 131.43;
    const pts = points(tabOutlinePaths(w, H, 7, 7).stroke);
    const n = pts.length;
    for (let i = 0; i < n; i += 1) {
      const [lx, ly] = pts[i]!;
      const [rx, ry] = pts[n - 1 - i]!;
      expect(lx + rx).toBeCloseTo(w, 3);
      expect(ly).toBeCloseTo(ry, 3);
    }
  });

  test("keeps fractional widths instead of snapping the right side", () => {
    const pts = points(tabOutlinePaths(131.43, H, 7, 7).stroke);
    const rightSide = 131.43 - 7.5;
    expect(pts.some(([x]) => Math.abs(x - rightSide) < 1e-6)).toBe(true);
  });

  test("closes the fill along the box bottom so it covers the baseline under the tab", () => {
    const pts = points(tabOutlinePaths(W, H, 7, 7).fill);
    const bottom = pts.filter(([, y]) => y === H);
    expect(bottom.length).toBeGreaterThanOrEqual(2);
    expect(Math.min(...bottom.map(([x]) => x))).toBe(1);
    expect(Math.max(...bottom.map(([x]) => x))).toBe(W - 1);
  });

  test("stays a valid path when the tab is narrower than its corners", () => {
    for (const [w, h] of [[20, 34], [16, 34], [60, 8]]) {
      const { fill, stroke } = tabOutlinePaths(w!, h!, 7, 7);
      for (const d of [fill, stroke]) {
        expect(d).not.toContain("NaN");
        expect(d.length).toBeGreaterThan(0);
        const xs = points(d).map(([x]) => x);
        expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
        expect(Math.max(...xs)).toBeLessThanOrEqual(w!);
        // The top corners never cross: left arc ends before the right begins.
        const tops = points(d).filter(([, y]) => y === 0.5).map(([x]) => x);
        expect(tops.length === 0 || tops[0]! <= tops[tops.length - 1]!).toBe(true);
      }
    }
  });
});
