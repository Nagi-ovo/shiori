import { sha256 } from '@noble/hashes/sha2.js';
import { parseCMap } from './cmap';
import { simpleNames } from './encodings';
import type { FontInput } from './types';
import { type3Bounds, type3Failure, type3PathProof, type3Transform, type Type3Box, type Type3Failure, type Type3Point } from './type3Paths';
export { checkType3Target, type Type3PaintState } from './type3Target';

export type Type3FontInput = FontInput & { type3CharProcs?: Readonly<Record<string, Uint8Array>> };
export type Type3GlyphProof = {
  code: number; name: string; procHash: string; dependencyHash: string;
  width1000: number; widthGlyph: number; fontMatrix: readonly number[];
  declaredBounds: Type3Box; rawHull: readonly Type3Point[]; rawBounds: Type3Box | null;
  inkHull: readonly Type3Point[]; inkBounds: Type3Box | null;
  readSet: readonly ['fillColor', 'callerTransform', 'clip', 'renderMode', 'fillAlpha', 'blendMode', 'softMask'];
};
const hash = (bytes: Uint8Array) => Array.from(sha256(bytes), b => b.toString(16).padStart(2, '0')).join('');

/** F8 only: cacheable proc/metrics proof; does not authorize the text walker. */
export function proveType3Glyph(input: Type3FontInput, code: number): { ok: true; proof: Type3GlyphProof } | Type3Failure {
  if (input.error) return type3Failure('content-malformed', input.error);
  if (input.subtype !== 'Type3' || !input.encoding || !Number.isInteger(code) || code < 0 || code > 255) return type3Failure('type3-charproc-missing', 'Type3 code has no defined CharProc');
  let name: string | undefined;
  try { name = simpleNames(input).get(code); }
  catch { return type3Failure('type3-charproc-missing', 'Type3 code has no supported existing Encoding'); }
  const proc = name && name !== '.notdef' ? input.type3CharProcs?.[name] : undefined;
  if (!name || !proc || !Object.hasOwn(input.type3CharProcs!, name)) return type3Failure('type3-charproc-missing', 'Type3 code has no defined CharProc');
  const m = input.fontMatrix;
  if (!m || m.length !== 6 || !m.every(Number.isFinite) || m[1] !== 0 || m[2] !== 0 || m[0]! <= 0 || m[3]! <= 0 || !Number.isFinite(m[0]! * m[3]!) || m[0]! * m[3]! === 0) return type3Failure('type3-matrix-unsupported', 'Unsupported Type3 FontMatrix');
  const first = input.firstChar, last = input.lastChar, widths = input.widths;
  const width = first === undefined ? undefined : widths?.[code - first];
  if (!Number.isInteger(first) || first! < 0 || first! > 255 || !Number.isInteger(last) || last! < first! || last! > 255 || code < first! || code > last! || width === undefined || !Number.isFinite(width) || !Number.isFinite(1000 * m[0]! * width)) return type3Failure('type3-width-invalid', 'Type3 Widths do not provide a horizontal width');
  const path = type3PathProof(proc);
  if (!path.ok) return path;
  if (path.wy !== 0 || Math.abs(path.wx - width) > 1e-6) return type3Failure('type3-width-invalid', 'Type3 Widths and d1 do not provide a consistent horizontal width');
  if (!path.hull.length) {
    let label: string | undefined;
    try { label = input.toUnicode ? parseCMap(input.toUnicode).unicode.get(code.toString(16).padStart(2, '0')) : undefined; }
    catch { /* An invalid map cannot prove that an empty glyph is whitespace. */ }
    if (!label || !/^[\p{White_Space}\p{Cf}]+$/u.test(label)) return type3Failure('type3-charproc-unsafe', 'Empty Type3 glyph is not proven whitespace/formatting');
  }
  const inkHull = type3Transform(path.hull, m);
  if (inkHull.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return type3Failure('type3-matrix-unsupported', 'Nonfinite Type3 ink transform');
  const procHash = hash(proc);
  const dependencyHash = hash(new TextEncoder().encode(JSON.stringify({ code, name, procHash, encoding: input.encoding, widths, first, last, matrix: m, toUnicode: input.toUnicode })));
  return { ok: true, proof: { code, name, procHash, dependencyHash, width1000: 1000 * m[0]! * width, widthGlyph: width,
    fontMatrix: [...m], declaredBounds: path.declaredBounds, rawHull: path.hull, rawBounds: type3Bounds(path.hull), inkHull, inkBounds: type3Bounds(inkHull),
    readSet: ['fillColor', 'callerTransform', 'clip', 'renderMode', 'fillAlpha', 'blendMode', 'softMask'] } };
}
