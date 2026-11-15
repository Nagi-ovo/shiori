import {RunCompileError} from './runRefusal';
import type { EncodeResult } from '../fontCoverage/types';
import type { ResolvedRunFont } from './replaceRun';
export const hex = (bytes: Uint8Array) => `<${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}>`;
export const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
export function pdfNumber(n: number): string {
  if (!Number.isFinite(n) || Math.abs(n) > 1e12) throw new RunCompileError('unrepresentable TJ compensation');
  // PDF numbers do not permit exponent notation. Keep the rounding error well
  // below 0.01pt even for large practical text sizes.
  return n.toFixed(10).replace(/\.?0+$/, '') || '0';
}
export function codes(bytes: Uint8Array, size: 1 | 2): number[] {
  if (bytes.length % size) throw new RunCompileError('unaligned source codes');
  return Array.from({ length: bytes.length / size }, (_, i) => size === 1
    ? bytes[i]! : bytes[2 * i]! * 256 + bytes[2 * i + 1]!);
}
export function encodeRun(text: string, font: ResolvedRunFont, original: Uint8Array, allowPermutation=false): EncodeResult {
  if ((/[\r\n]/.test(text) || text.includes(String.fromCharCode(0)))) throw new RunCompileError('replacement is not a single text run');
  if(allowPermutation){const reused=existingCodePermutation(text,font,original);if(reused)return reused;}
  if (!font.canEncode) return { ok: false, reason: 'source font coverage unavailable', firstMissing: Array.from(text)[0] ?? '', offset: 0 };
  const preferredCodes = codes(original, font.bytesPerCode).map((_, i) => original.slice(i * font.bytesPerCode, (i + 1) * font.bytesPerCode));
  const result = font.canEncode(text, { preferredCodes });
  if (!result.ok) return result;
  if (result.codes.some(c => c.length !== font.bytesPerCode) ||
      result.codes.reduce((n, c) => n + c.length, 0) !== result.bytes.length ||
      !same(Uint8Array.from(result.codes.flatMap(c => [...c])), result.bytes)) throw new RunCompileError('invalid verified code boundaries','font-coverage');
  const decoded = codes(result.bytes, font.bytesPerCode).map(c => font.unicodeByCode.get(c));
  if (decoded.some(c => c === undefined) || decoded.join('') !== text) throw new RunCompileError('verified codes disagree with ToUnicode','font-coverage');
  return result;
}

export function pdfName(name: string): string {
  const bytes = Array.from(name, c => c.charCodeAt(0));
  if (bytes.some(b => b > 255)) throw new RunCompileError('invalid PDF resource name');
  return '/' + bytes.map(b => b >= 33 && b <= 126 && !'()<>[]{}/%#'.includes(String.fromCharCode(b)) ? String.fromCharCode(b) : '#' + b.toString(16).padStart(2,'0')).join('');
}

/** Reorder exactly the scalar/code multiset already addressed, never invent a
 * code or assume that an unparsed Type1 program covers a new character. */
export function existingCodePermutation(text:string,font:ResolvedRunFont,original:Uint8Array):EncodeResult|null {
 const originalCodes=codes(original,font.bytesPerCode),byScalar=new Map<string,number>();
 const scalars=originalCodes.map(code=>font.unicodeByCode.get(code));
 if(scalars.some(s=>!s || Array.from(s).length!==1))return null;
 for(let i=0;i<originalCodes.length;i++){const scalar=scalars[i]!;const previous=byScalar.get(scalar);if(previous!==undefined && previous!==originalCodes[i])return null;byScalar.set(scalar,originalCodes[i]!);}
 const replacement=Array.from(text);if(replacement.length!==scalars.length)return null;
 if([...replacement].sort().join('')!==[...scalars].sort().join(''))return null;
 const encoded=replacement.map(s=>{const code=byScalar.get(s)!;return font.bytesPerCode===1?Uint8Array.of(code):Uint8Array.of(code>>8,code&255);});
 return{ok:true,bytes:Uint8Array.from(encoded.flatMap(c=>[...c])),codes:encoded,preferredApplied:true};
}
