// Evidence is collected from native PDFium's rendered output, not ToUnicode.
export type GlyphEvidence = { unicode: string; replacement?: boolean; glyphId?: number; pathSegments?: number; inkPixels?: number };
export function assertReplacementGlyphs(glyphs: readonly GlyphEvidence[]): number {
  let checked = 0;
  for (const glyph of glyphs) {
    if (!glyph.replacement || /^\s+$/u.test(glyph.unicode)) continue;
    if (!Number.isInteger(glyph.glyphId) || glyph.glyphId! <= 0 ||
        !Number.isFinite(glyph.pathSegments) || glyph.pathSegments! <= 0 ||
        !Number.isFinite(glyph.inkPixels) || glyph.inkPixels! <= 0) {
      throw Error(`absent/blank native replacement glyph ${JSON.stringify(glyph.unicode)}`);
    }
    checked++;
  }
  return checked;
}
