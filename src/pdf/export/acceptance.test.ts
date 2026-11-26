import { expect, test } from "bun:test";
import { evaluateAcceptance } from "./acceptance";
import type { ContentTextOutcome } from "./contentText/outcomes";
import type { RetypesetManifest } from "./contentText/retypesetTypes";

const region = Object.freeze({ x: 15.25, y: 42.5, w: 2.75, h: 1 });

test("reports measured contact and analytic overflow independently of counters and notes", () => {
  const retypeset: RetypesetManifest = {
    reason: "overflow", paragraphBox: { x: 10, y: 35, w: 40, h: 20 },
    substituteFont: "Bundled Sans", lineCount: 2, overflowed: true, pushed: false,
    unchangedLineDriftPt: 0, pushedDeltaPt: 0, pushedRegions: [], overflowInkOverlap: true,
    quality: { maxUnchangedLineStartXDriftPt: 0, maxUnchangedLineBaselineDriftPt: 0, overflowInkOverlap: true },
  };
  const collision: ContentTextOutcome = Object.freeze({
    overlayId: "overlap", pageIndex: 0, mode: "retypeset", fidelity: "approximate",
    contact: Object.freeze({ kind: "new-collision" as const, region }), retypeset: Object.freeze(retypeset),
    strippedEquivalent: true,
  });
  const input = Object.freeze({
    clippedChars: 3, lostChars: 2, unexcisedEdits: 1,
    contentTextOutcomes: [
      collision,
      { overlayId: "old", pageIndex: 1, mode: "in-place", contact: { kind: "pre-existing-contact" }, sourceSpacingAdjusted: true },
      { overlayId: "unknown", mode: "fallback-font", contact: { kind: "uncertain" } },
    ] satisfies ContentTextOutcome[],
  });
  Object.freeze(input.contentTextOutcomes);

  const review = evaluateAcceptance(input, "review", "candidate");
  expect(review).toMatchObject({ policy: "review", status: "needs-review", key: "candidate" });
  expect(review.findings).toHaveLength(7);
  expect(review.findings).toEqual(expect.arrayContaining([
    { kind: "clipped-text", count: 3 },
    { kind: "lost-text", count: 2 },
    { kind: "unexcised-edit", count: 1 },
    { kind: "new-collision", overlayId: "overlap", pageIndex: 0, region },
    { kind: "overflow-envelope", overlayId: "overlap", pageIndex: 0 },
    { kind: "stripped-equivalent", overlayId: "overlap", pageIndex: 0 },
    { kind: "uncertain-contact", overlayId: "unknown" },
  ]));
  expect(review.notes).toHaveLength(5);
  expect(review.notes).toEqual(expect.arrayContaining([
    { kind: "pre-existing-contact", overlayId: "old" },
    { kind: "substituted-face", overlayId: "overlap" },
    { kind: "substituted-face", overlayId: "unknown" },
    { kind: "spacing-adjusted", overlayId: "old" },
    { kind: "approximate-fidelity", overlayId: "overlap" },
  ]));
  expect(evaluateAcceptance(input, "strict", "candidate")).toEqual({
    ...review, policy: "strict", status: "refused",
  });
});

test("accepts missing evidence and discloses existing contact without blocking", () => {
  expect(evaluateAcceptance({ lostChars: 0 }, "review")).toEqual({
    policy: "review", status: "accepted", findings: [], notes: [], key: expect.any(String),
  });
  expect(evaluateAcceptance({
    lostChars: 0, clippedChars: -1, unexcisedEdits: 0,
    contentTextOutcomes: [
      { overlayId: "unwritten", mode: "unsupported", contact: { kind: "uncertain" }, strippedEquivalent: true },
      { overlayId: "clear", mode: "in-place", contact: { kind: "clear" } },
      { overlayId: "old", mode: "in-place", contact: { kind: "pre-existing-contact" } },
    ],
  }, "strict", "")).toEqual({
    policy: "strict", status: "accepted", findings: [], key: "",
    notes: [{ kind: "pre-existing-contact", overlayId: "old" }],
  });
});
