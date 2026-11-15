import type { EncodeResult } from '../fontCoverage/types';
import type { ResolvedRunFont } from './replaceRun';
export const hex = (bytes: Uint8Array) => `<${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}>`;
export const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
export function pdfNumber(n: number): string {
  if (!Number.isFinite(n) || Math.abs(n) > 1e12) throw Error('unrepresentable TJ compensation');
  // PDF numbers do not permit exponent notation. Keep the rounding error well
  // below 0.01pt even for large practical text sizes.
  return n.toFixed(10).replace(/\.?0+$/, '') || '0';
}
export function codes(bytes: Uint8Array, size: 1 | 2): number[] {
  if (bytes.length % size) throw Error('unaligned source codes');
  return Array.from({ length: bytes.length / size }, (_, i) => size === 1
    ? bytes[i]! : bytes[2 * i]! * 256 + bytes[2 * i + 1]!);
}
export function encodeRun(text: string, font: ResolvedRunFont, original: Uint8Array): EncodeResult {
  if ((/[\r\n]/.test(text) || text.includes(String.fromCharCode(0)))) throw Error('replacement is not a single text run');
  if (!font.canEncode) return { ok: false, reason: 'source font coverage unavailable', firstMissing: Array.from(text)[0] ?? '', offset: 0 };
  const preferredCodes = codes(original, font.bytesPerCode).map((_, i) => original.slice(i * font.bytesPerCode, (i + 1) * font.bytesPerCode));
  const result = font.canEncode(text, { preferredCodes });
  if (!result.ok) return result;
  if (result.codes.some(c => c.length !== font.bytesPerCode) ||
      result.codes.reduce((n, c) => n + c.length, 0) !== result.bytes.length ||
      !same(Uint8Array.from(result.codes.flatMap(c => [...c])), result.bytes)) throw Error('invalid verified code boundaries');
  const decoded = codes(result.bytes, font.bytesPerCode).map(c => font.unicodeByCode.get(c));
  if (decoded.some(c => c === undefined) || decoded.join('') !== text) throw Error('verified codes disagree with ToUnicode');
  return result;
}

export function pdfName(name: string): string {
  const bytes = Array.from(name, c => c.charCodeAt(0));
  if (bytes.some(b => b > 255)) throw Error('invalid PDF resource name');
  return '/' + bytes.map(b => b >= 33 && b <= 126 && !'()<>[]{}/%#'.includes(String.fromCharCode(b)) ? String.fromCharCode(b) : '#' + b.toString(16).padStart(2,'0')).join('');
}
