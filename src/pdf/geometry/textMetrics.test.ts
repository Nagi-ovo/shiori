import { describe, expect, test } from "bun:test";
import { deterministicTextVerticalMetrics } from "./textMetrics";

describe("deterministicTextVerticalMetrics", () => {
  test("normalizes a plausible oversized font bbox to one em", () => {
    const metrics = deterministicTextVerticalMetrics(10.8, {
      ascent: 1.06,
      descent: -0.34,
    });
    expect(metrics.ascent + metrics.descent).toBeCloseTo(10.8, 10);
    expect(metrics.ascent / metrics.descent).toBeCloseTo(1.06 / 0.34, 10);
  });

  test("rejects a positive PDF descent before taking its magnitude", () => {
    expect(
      deterministicTextVerticalMetrics(10, { ascent: 0.7, descent: 0.2 }),
    ).toEqual({ ascent: 8, descent: 2 });
  });

  test("rejects implausible ascent shares even for a sub-em bbox", () => {
    expect(
      deterministicTextVerticalMetrics(10, { ascent: 0.1, descent: -0.4 }),
    ).toEqual({ ascent: 8, descent: 2 });
  });

  test("keeps ordinary sub-em metrics and safely handles invalid heights", () => {
    expect(
      deterministicTextVerticalMetrics(10, { ascent: 0.7, descent: -0.1 }),
    ).toEqual({ ascent: 7, descent: 1 });
    expect(deterministicTextVerticalMetrics(-10, undefined)).toEqual({
      ascent: 0,
      descent: 0,
    });
  });
});
