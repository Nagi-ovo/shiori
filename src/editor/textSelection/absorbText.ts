// Substitution step of contentText edit absorption (see addContentTextEdit
// in TextHighlightLayer): when a new edit overlaps an old one, the old
// overlay is removed and its replacement text is spliced into the new
// edit's initial text so the earlier change is not lost.
//
// The old overlay's originalText and the new edit's text come from
// different extraction passes — a DOM-selection capture vs paragraph-run
// synthesis — so the same source text can differ in whitespace (line joins
// become spaces, word gaps become synthesized spaces). A literal indexOf
// misses on any such difference and the earlier edit silently reverts.
// Match with a whitespace-collapsed pattern instead, and splice by index —
// String.replace(searchString, replacement) would interpret `$` patterns
// inside the user's replacement text.

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function substituteAbsorbedText(
  initialText: string,
  originalText: string | undefined,
  replacement: string,
): string {
  const span = absorbedSpan(initialText, originalText);
  if (!span) return initialText;
  return initialText.slice(0, span.start) + replacement + initialText.slice(span.end);
}

/** Where `originalText` sits in `text`, whitespace-tolerantly; null if absent. */
function absorbedSpan(
  text: string,
  originalText: string | undefined,
): { start: number; end: number } | null {
  // A blank originalText would match at position 0 and inject the
  // replacement out of nowhere — treat it as "nothing to substitute".
  if (!originalText || originalText.trim() === "") return null;
  const pattern = new RegExp(escapeRegExp(originalText).replace(/\s+/g, "\\s+"));
  const match = pattern.exec(text);
  return match ? { start: match.index, end: match.index + match[0].length } : null;
}

/** One splice: [start, end) of the text before it became `length` units. */
export type AbsorbStep = { start: number; end: number; length: number } | null;

/** Splice each absorbed edit's text in turn, recording where it went. */
export function absorbEdits(
  text: string,
  absorbed: readonly { originalText?: string; text: string }[],
): { text: string; steps: AbsorbStep[] } {
  const steps: AbsorbStep[] = [];
  for (const old of absorbed) {
    const span = absorbedSpan(text, old.originalText);
    steps.push(span && { ...span, length: old.text.length });
    if (span) text = text.slice(0, span.start) + old.text + text.slice(span.end);
  }
  return { text, steps };
}

/**
 * An offset in the opened text for a hit at `offset` of the source text
 * (step null) or of absorbed edit `step`'s text. A source hit inside a span
 * that an edit replaced takes the nearer edge of that edit.
 */
export function mapAbsorbedOffset(
  absorption: { steps: readonly AbsorbStep[] },
  hit: { step: number | null; offset: number },
): number {
  const first = hit.step === null ? 0 : hit.step + 1;
  const own = hit.step === null ? null : absorption.steps[hit.step];
  if (hit.step !== null && !own) return hit.offset;
  let offset = own ? own.start + Math.min(hit.offset, own.length) : hit.offset;
  for (const step of absorption.steps.slice(first)) {
    if (!step || offset <= step.start) continue;
    if (offset >= step.end) offset += step.length - (step.end - step.start);
    else offset = offset - step.start <= step.end - offset ? step.start : step.start + step.length;
  }
  return offset;
}
