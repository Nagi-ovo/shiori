import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFString, pdfDocEncodingDecode } from 'pdf-lib';
import type { PDFObject } from 'pdf-lib';
import { decodeLiteralString } from '../contentStreamEdit/tokenizer';

export const entry = (dict: PDFDict, key: string) => dict.get(PDFName.of(key));
export const value = (dict: PDFDict, key: string) => dict.context.lookup(entry(dict, key));
export const asDict = (v: PDFObject | undefined) => v instanceof PDFDict ? v : undefined;
export const asName = (v: PDFObject | undefined) => v instanceof PDFName ? v.decodeText() : undefined;

export function asIndex(v: PDFObject | undefined): number | undefined {
  const n = v instanceof PDFNumber ? v.asNumber() : undefined;
  return n !== undefined && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

export function numberArray(v: PDFObject | undefined, length: number): number[] | undefined {
  if (!(v instanceof PDFArray) || v.size() !== length) return undefined;
  const numbers = v.asArray().map((_, index) => {
    const real = v.lookup(index);
    return real instanceof PDFNumber ? real.asNumber() : NaN;
  });
  return numbers.every(Number.isFinite) ? numbers : undefined;
}

export function decodeTextBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder().decode(bytes);
  return pdfDocEncodingDecode(bytes);
}

export function asText(v: PDFObject | undefined): string | undefined {
  if (v instanceof PDFHexString) return decodeTextBytes(v.asBytes());
  if (v instanceof PDFString) {
    try { return decodeTextBytes(decodeLiteralString(v.asString())); }
    catch { return undefined; }
  }
}
