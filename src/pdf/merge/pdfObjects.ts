// Tolerant pdf-lib object lookups shared by page insertion's walkers.
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFObject,
  PDFRef,
  PDFString,
} from "pdf-lib";

export const MAX_DESTINATION_DEPTH = 64;

export function destinationName(
  document: PDFDocument,
  raw: PDFObject | undefined,
): string | undefined {
  const value = resolveObject(document, raw);
  return value instanceof PDFName ||
    value instanceof PDFString ||
    value instanceof PDFHexString
    ? value.decodeText()
    : undefined;
}

export function lookupArray(
  document: PDFDocument,
  raw: PDFObject | undefined,
): PDFArray | undefined {
  const value = resolveObject(document, raw);
  return value instanceof PDFArray ? value : undefined;
}

export function lookupDict(
  document: PDFDocument,
  raw: PDFObject | undefined,
): PDFDict | undefined {
  const value = resolveObject(document, raw);
  return value instanceof PDFDict ? value : undefined;
}

export function resolveObject(
  document: PDFDocument,
  raw: PDFObject | undefined,
): PDFObject | undefined {
  if (!raw || !(raw instanceof PDFRef)) return raw;
  try {
    return document.context.lookup(raw);
  } catch {
    return undefined;
  }
}

export function isName(
  document: PDFDocument,
  raw: PDFObject | undefined,
  expected: string,
): boolean {
  const value = resolveObject(document, raw);
  return value instanceof PDFName && value.decodeText() === expected;
}
