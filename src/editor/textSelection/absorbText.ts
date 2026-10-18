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
  // A blank originalText would match at position 0 and inject the
  // replacement out of nowhere — treat it as "nothing to substitute".
  if (!originalText || originalText.trim() === "") return initialText;
  const pattern = new RegExp(escapeRegExp(originalText).replace(/\s+/g, "\\s+"));
  const match = pattern.exec(initialText);
  if (!match) return initialText;
  return (
    initialText.slice(0, match.index) +
    replacement +
    initialText.slice(match.index + match[0].length)
  );
}
