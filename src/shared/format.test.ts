import { describe, expect, test } from "bun:test";
import { formatRelative, nextRelativeChangeAt } from "./format";

describe("nextRelativeChangeAt", () => {
  // The boundary must be exactly where formatRelative's output flips: one
  // millisecond before it the label is unchanged, at it the label differs.
  test("names the exact instant the relative label changes", () => {
    const past = 1_700_000_000_000;
    const deltas = [
      0, 1_000, 44_999, 45_000, 59_999, 60_000, 61_000, 3_599_999, 3_600_000,
      5 * 3_600_000 + 12_345, 86_399_999, 86_400_000, 3 * 86_400_000 + 7,
      10 * 86_400_000,
    ];
    for (const delta of deltas) {
      const now = past + delta;
      const next = nextRelativeChangeAt(past, now);
      expect(next).toBeGreaterThan(now);
      expect(formatRelative(past, next - 1)).toBe(formatRelative(past, now));
      expect(formatRelative(past, next)).not.toBe(formatRelative(past, now));
    }
  });

  // formatRelative clamps a future timestamp to "just now"; that label then
  // holds until 45s after the timestamp itself, not after now.
  test("measures a future timestamp from the timestamp", () => {
    const now = 1_700_000_000_000;
    expect(nextRelativeChangeAt(now + 5_000, now)).toBe(now + 5_000 + 45_000);
  });
});
