import { describe, expect, test } from "bun:test";
import {
  armEditDragBlurSuppression,
  consumeEditDragBlurSuppression,
} from "./editDragBlurSuppression";

describe("editDragBlurSuppression", () => {
  test("arms a suppression that consumes a matching blur within the window", () => {
    const armed = armEditDragBlurSuppression("note-a", 1000, 250);
    const result = consumeEditDragBlurSuppression(armed, "note-a", 1100);
    expect(result.suppress).toBe(true);
    expect(result.next).toBeNull();
  });

  test("does not consume blurs after the suppression window has elapsed", () => {
    // WebKit can deliver a blur after the user has already typed input.
    // Time-bounding (instead of clearing on input) means an *expired* arm
    // cleanly falls through to the normal commit path rather than
    // swallowing input-driven blurs.
    const armed = armEditDragBlurSuppression("note-a", 1000, 250);
    const result = consumeEditDragBlurSuppression(armed, "note-a", 1300);
    expect(result.suppress).toBe(false);
    expect(result.next).toBeNull();
  });

  test("does not consume blurs from a different overlay", () => {
    // Mismatched id leaves the arm intact so the original overlay's
    // late blur still has a chance to be suppressed.
    const armed = armEditDragBlurSuppression("note-a", 1000, 250);
    const result = consumeEditDragBlurSuppression(armed, "note-b", 1100);
    expect(result.suppress).toBe(false);
    expect(result.next).toEqual(armed);
  });

  test("returns no-suppress when nothing is armed", () => {
    const result = consumeEditDragBlurSuppression(null, "note-a", 1000);
    expect(result.suppress).toBe(false);
    expect(result.next).toBeNull();
  });

  test("a single arm only suppresses the first blur", () => {
    // The suppression is one-shot: after consuming, `next` is null so a
    // second blur (e.g. user genuinely tabbing away) commits normally.
    const armed = armEditDragBlurSuppression("note-a", 1000, 250);
    const first = consumeEditDragBlurSuppression(armed, "note-a", 1100);
    expect(first.suppress).toBe(true);
    const second = consumeEditDragBlurSuppression(first.next, "note-a", 1110);
    expect(second.suppress).toBe(false);
    expect(second.next).toBeNull();
  });

  test("re-arming after a long drag covers blurs that fire well past the pointerdown window", () => {
    // The original arm was set at `onOverlayPointerDown`, so a drag longer
    // than 250ms would expire the suppression before pointerup/finalize.
    // The fix re-arms in
    // `finalizeDrag` so the window is anchored to gesture end. This
    // test locks down the property of arm-replaces-state that the
    // re-arm relies on.
    let state = armEditDragBlurSuppression("note-a", 0, 250);
    // 500ms of drag passes — original arm has long expired.
    const expiredCheck = consumeEditDragBlurSuppression(
      state,
      "note-a",
      500,
    );
    expect(expiredCheck.suppress).toBe(false);
    // finalizeDrag re-arms with the gesture-end timestamp.
    state = armEditDragBlurSuppression("note-a", 500, 250);
    // The WebKit late blur arrives a few ms after the refocus.
    const lateBlur = consumeEditDragBlurSuppression(state, "note-a", 530);
    expect(lateBlur.suppress).toBe(true);
  });

  test("regression: drag → finalizeDrag refocus → user input → delayed blur", () => {
    // 1. Pointerdown on the editing note arms suppression.
    let state = armEditDragBlurSuppression("note-a", 1000, 250);
    // 2. finalizeDrag refocuses the textarea — no blur to consume yet.
    // 3. User types: this MUST NOT clear the suppression (the v3 bug).
    //    State is unchanged.
    // 4. Delayed blur arrives a bit later, still within the window.
    const blur = consumeEditDragBlurSuppression(state, "note-a", 1080);
    expect(blur.suppress).toBe(true);
    state = blur.next;
    // 5. Subsequent legitimate blur is no longer swallowed.
    const next = consumeEditDragBlurSuppression(state, "note-a", 2000);
    expect(next.suppress).toBe(false);
  });
});
