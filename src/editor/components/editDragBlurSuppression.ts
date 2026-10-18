// Sticky-note edit + drag interleaves with WebKit's blur dispatch in
// ways that can fire a textarea blur AFTER the pointer gesture has
// ended and AFTER `finalizeDrag` has refocused the textarea. The blur
// then runs through the normal commit path (empty text → auto-delete /
// exit editing), kicking the user out of the note they meant to edit.
//
// We arm a one-shot, time-bounded suppression at the moment a drag
// starts on an overlay that is being edited. The next blur on that
// overlay within the suppression window is consumed; older or
// mismatched blurs fall through to the normal commit path.
//
// Why time-bounded instead of "until next input": clearing on the next
// `onInput` made WebKit's delayed blur land *after* input — so the
// suppression was already cleared and the blur still deleted the note.

export type EditDragBlurSuppression = {
  id: string;
  expiresAt: number;
};

// 250 ms covers observed WebKit late-blur latencies during a sticky-
// note drag without lingering long enough to swallow a legitimate
// blur from a deliberate click-out gesture.
export const EDIT_DRAG_BLUR_SUPPRESSION_MS = 250;

export function armEditDragBlurSuppression(
  id: string,
  now: number,
  durationMs: number = EDIT_DRAG_BLUR_SUPPRESSION_MS,
): EditDragBlurSuppression {
  return { id, expiresAt: now + durationMs };
}

export function consumeEditDragBlurSuppression(
  state: EditDragBlurSuppression | null,
  overlayId: string,
  now: number,
): { suppress: boolean; next: EditDragBlurSuppression | null } {
  if (!state) return { suppress: false, next: null };
  if (state.id !== overlayId) return { suppress: false, next: state };
  if (now >= state.expiresAt) return { suppress: false, next: null };
  return { suppress: true, next: null };
}
