import { describe, expect, test } from "bun:test";
import { sourceLinePitchPt } from "./baselines";

describe("sourceLinePitchPt", () => {
  test("returns the median gap of multi-line baselines", () => {
    // Top line first, page space: y decreases downward.
    expect(sourceLinePitchPt([700, 685.5, 671])).toBeCloseTo(14.5, 5);
  });

  test("median resists one odd gap", () => {
    expect(sourceLinePitchPt([700, 686, 672, 630])).toBe(14);
  });

  test("null for single or missing baselines", () => {
    expect(sourceLinePitchPt([700])).toBeNull();
    expect(sourceLinePitchPt(undefined)).toBeNull();
  });

  test("null when no gap is positive", () => {
    expect(sourceLinePitchPt([700, 700])).toBeNull();
  });
});
