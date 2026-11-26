import type { PdfTextGlyph } from '../engine/text';
import type { ContentTextOverlay, PdfPoint, PdfRect } from './types';

export type SourceGlyph = Pick<PdfTextGlyph, 'text' | 'origin' | 'end'>;

/** Measure horizontal source cells near the selection, including adjacent
 * glyphs that can witness a replacement or the end of its word. */
export function observeSourceGlyphs(
  glyphs: readonly SourceGlyph[] | null | undefined,
  covers: readonly PdfRect[],
  size: number,
  offset: PdfPoint = { x: 0, y: 0 },
): ContentTextOverlay['sourceGlyphs'] {
  const observed = [];
  for (const glyph of glyphs ?? []) {
    const x = glyph.origin.x - offset.x;
    const y = glyph.origin.y - offset.y;
    const advance = glyph.end.x - glyph.origin.x;
    if (!(advance > 0) || Math.abs(glyph.end.y - glyph.origin.y) > .01) continue;
    if (!covers.some(r => y >= r.y - .1 && y <= r.y + r.h + .1 &&
      x >= r.x - size && x <= r.x + r.w + size)) continue;
    observed.push({ text: glyph.text, x, y, advance });
    if (observed.length > 512) return;
  }
  return observed.length ? observed : undefined;
}
