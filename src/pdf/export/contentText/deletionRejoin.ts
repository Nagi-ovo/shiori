import type { RunEdit } from '../contentStreamEdit/replaceRun';
import type { GlyphPlacement, ShowTextState } from '../contentStreamEdit/textState';
import type { ContentOp } from '../contentStreamEdit/tokenizer';
import type { TextChange } from './diff';

export type MappedGlyph = { g: GlyphPlacement; start: number; end: number };

/** Close only the contiguous selected suffix, through its last retained non-space glyph.
 * A gap in the selection, a positioning/state operator, or a gap wider
 * than local kerning ends ownership even within the same text object.
 * Null means a multi-hunk edit crosses a boundary without a proved separator. */
export function deletionRejoin(
  original: string,
  changes: readonly TextChange[],
  index: number,
  mapped: readonly MappedGlyph[],
  glyphs: readonly GlyphPlacement[],
  ops: readonly ContentOp[],
  state: ShowTextState,
): RunEdit['closeUpThrough'] | null {
  const change = changes[index]!;
  const start = mapped.findIndex(m => m.start === change.start);
  if (start < 0) return;
  const first = mapped[start]!.g;
  const sourceIndex = glyphs.indexOf(first);
  const pointPerUnit = state.fontSize * state.advanceVector.x / 1000;
  const advance = (g: GlyphPlacement) => g.tjCompensation * pointPerUnit;
  const maxKern = (state.fontSizePt ?? state.fontSize) * 0.2;
  let removedAdvance = 0;
  let suffixStart: GlyphPlacement | undefined;
  let suffixEnd: GlyphPlacement | undefined;
  let nextIndex = index + 1;
  for (let i = start; i < mapped.length; i++) {
    const { g, start: offset, end } = mapped[i]!;
    const previous = i > start ? mapped[i - 1] : undefined;
    if (previous && previous.end !== offset) break;
    if (previous && Math.abs(previous.g.coreQuad[0].x + advance(previous.g) - g.coreQuad[0].x) > maxKern) {
      const retainsSpace = (m: MappedGlyph) => /^\s+$/u.test(original.slice(m.start, m.end)) &&
        !changes.some(c => c.start < m.end && c.end > m.start);
      if (changes.length > 1 && !retainsSpace(previous) && !retainsSpace(mapped[i]!)) return null;
      break;
    }
    if (glyphs[sourceIndex + i - start] !== g ||
        g.fontName !== first.fontName || g.coreQuad[1].x <= g.coreQuad[0].x ||
        ops.slice(previous?.g.opIndex ?? g.opIndex, g.opIndex + 1).some(op => op.operator !== 'Tj' && op.operator !== 'TJ')) {
      if (changes.length > 1) return null;
      break;
    }
    if (end <= change.end) {
      removedAdvance += advance(g);
      continue;
    }
    if (!suffixStart && offset !== change.end) break;
    while (changes[nextIndex] && changes[nextIndex]!.end <= offset) nextIndex++;
    const next = changes[nextIndex];
    const deletedLater = next && end > next.start;
    // Deletions within a continuous run share the final retained boundary.
    suffixStart ??= g;
    if (!deletedLater && /\S/u.test(original.slice(offset, end))) suffixEnd = g;
  }
  if (!suffixStart || !suffixEnd) return;
  // Keep the gap before the deletion and the spacing within the retained
  // suffix. Gaps traversed by the removed glyphs belong to the deletion.
  const gapPt = suffixStart.coreQuad[0].x - first.coreQuad[0].x - removedAdvance;
  return {
    opIndex: suffixEnd.opIndex,
    itemIndex: suffixEnd.arrayItemIndex,
    byteEnd: suffixEnd.byteOffset + suffixEnd.byteLength,
    gapPt,
  };
}
