// Geometry comes from native PDFium. Coverage GIDs are only an extra guard.
export type NativePathSegment = { type: number; point: readonly number[]; closed: boolean };
export type NativePath = readonly NativePathSegment[];
export type NotdefProbe = { scalar: number; path: NativePath | null };
export type GlyphEvidence = { unicode: string; replacement?: boolean; glyphId?: number; pathSegments?: number;
  inkPixels?: number; nativePath?: NativePath | null; notdefProbes?: readonly NotdefProbe[] };
export class GlyphEvidenceError extends Error {
  constructor(readonly code: 'native-notdef-match' | 'native-notdef-probe-unavailable' | 'native-notdef-probe-ambiguous' |
    'blank-native-glyph' | 'coverage-glyph-unverified', reason: string, unicode: string) {
    super(`${reason} ${JSON.stringify(unicode)}`);
  }
}
const validPath = (path: NativePath) => Array.isArray(path) && path.every(s => [0, 1, 2].includes(s.type) &&
  s.point.length === 2 && s.point.every(Number.isFinite) && typeof s.closed === 'boolean');
const pathKey = (path: NativePath | null) => JSON.stringify(path?.map(s => [s.type, ...s.point, s.closed]) ?? null);
export function assertReplacementGlyphs(glyphs: readonly GlyphEvidence[]): number {
  let checked = 0;
  for (const glyph of glyphs) {
    if (!glyph.replacement || /^\s+$/u.test(glyph.unicode)) continue;
    const fail = (code: GlyphEvidenceError['code'], reason: string): never => { throw new GlyphEvidenceError(code, reason, glyph.unicode); };
    if (!glyph.nativePath?.length || !validPath(glyph.nativePath) || glyph.pathSegments !== glyph.nativePath.length ||
        !Number.isFinite(glyph.inkPixels) || glyph.inkPixels! <= 0) {
      fail('blank-native-glyph', 'absent/blank native replacement glyph');
    }
    const probes = glyph.notdefProbes;
    if (!probes || new Set(probes.map(p => p.scalar)).size < 2 || probes.some(p =>
      !Number.isInteger(p.scalar) || p.scalar < 0 || p.scalar > 0x10ffff ||
      (p.path !== null && (!p.path || !validPath(p.path))))) {
      fail('native-notdef-probe-unavailable', 'native .notdef probe unavailable');
    }
    const keys = new Set(probes!.map(p => pathKey(p.path)));
    if (keys.size !== 1) fail('native-notdef-probe-ambiguous', 'native .notdef probe ambiguous');
    if (keys.has(pathKey(glyph.nativePath!))) fail('native-notdef-match', 'native .notdef path match');
    if (!Number.isInteger(glyph.glyphId) || glyph.glyphId! <= 0) fail('coverage-glyph-unverified', 'unverified coverage GID');
    checked++;
  }
  return checked;
}
