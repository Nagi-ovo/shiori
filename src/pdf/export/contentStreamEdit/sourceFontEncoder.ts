// Same-font replacement for the contentText export: encode a Unicode string
// into show-string bytes for a font ALREADY embedded in the source PDF, so
// the replacement text can be drawn with the original font and become
// visually indistinguishable from untouched text.
//
// The code→Unicode mapping comes from the font's /ToUnicode CMap — the same
// table extractors rely on, so it exists in any PDF whose text is
// searchable, and in a SUBSET font it only lists glyphs the subset actually
// contains, which makes its inversion a safe "is this glyph available"
// oracle. No font-program parsing.
//
// Fail-closed like the rest of this directory: no /ToUnicode, an unsupported
// font per glyphWidths, a parse error, or any character without a unique
// single-code mapping → null, and the caller falls back to drawing with the
// app's bundled fonts.

import type { PDFDict } from "pdf-lib";
import { decodePDFRawStream, PDFName, PDFRawStream, PDFRef } from "pdf-lib";
import { contentFontInfo } from "./glyphWidths";

export type EncodedLine = {
  bytes: Uint8Array;
  // Advance width of the whole line in em units (glyph-space /1000 summed),
  // multiply by font size for text-space points.
  widthEm: number;
};

export type SourceFontEncoder = {
  bytesPerCode: 1 | 2;
  // Encode one line of text. Null when any character lacks a glyph in this
  // font (or maps ambiguously) — the caller must fall back for the whole
  // overlay, mixing fonts within one edit would look worse than the bundled
  // font does.
  encodeLine: (text: string) => EncodedLine | null;
};

// Hard cap on bfrange spans. Real CMaps stay tiny (a subset has at most a
// few thousand glyphs); a corrupt hi bound must not allocate gigabytes.
const MAX_RANGE_SPAN = 65536;

function hexToBytes(hex: string): Uint8Array | null {
  const compact = hex.replace(/[\s\r\n]/g, "");
  if (compact.length % 2 !== 0) return null;
  const out = new Uint8Array(compact.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(compact.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return null;
    out[i] = byte;
  }
  return out;
}

function bytesToCode(bytes: Uint8Array): number {
  let code = 0;
  for (const byte of bytes) code = code * 256 + byte;
  return code;
}

// Destination hex strings are UTF-16BE. Surrogate pairs combine naturally
// through fromCharCode on consecutive 16-bit units.
function utf16beToString(bytes: Uint8Array): string | null {
  if (bytes.length % 2 !== 0) return null;
  let out = "";
  for (let i = 0; i < bytes.length; i += 2) {
    out += String.fromCharCode(bytes[i]! * 256 + bytes[i + 1]!);
  }
  return out;
}

type CMapToken =
  | { kind: "hex"; value: string }
  | { kind: "keyword"; value: string }
  | { kind: "arrayStart" }
  | { kind: "arrayEnd" };

// Minimal CMap tokenizer: hex strings, [ ] delimiters, and bare keywords.
// Numbers (codespace bounds, usecmap args) come through as keywords and are
// simply not consumed by the bf-section parser below.
function tokenizeCMap(text: string): CMapToken[] | null {
  const tokens: CMapToken[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "%") {
      // Comment runs to end of line.
      while (i < text.length && text[i] !== "\n") i += 1;
    } else if (ch === "<") {
      const end = text.indexOf(">", i + 1);
      if (end === -1) return null;
      tokens.push({ kind: "hex", value: text.slice(i + 1, end) });
      i = end + 1;
      continue;
    } else if (ch === "[") {
      tokens.push({ kind: "arrayStart" });
    } else if (ch === "]") {
      tokens.push({ kind: "arrayEnd" });
    } else if (!/\s/.test(ch)) {
      let end = i;
      while (end < text.length && !/[\s<>[\]%]/.test(text[end]!)) end += 1;
      if (end === i) {
        // A lone delimiter (e.g. the second ">" of a ">>" dict close) —
        // skip it, or the scan would stall producing empty keywords.
        i += 1;
        continue;
      }
      tokens.push({ kind: "keyword", value: text.slice(i, end) });
      i = end;
      continue;
    }
    i += 1;
  }
  return tokens;
}

// Parse bfchar/bfrange sections into code → Unicode string. Entries whose
// source byte length disagrees with the font's code width are skipped, not
// fatal — multi-codespace CMaps exist but our walk only models uniform
// 1- or 2-byte codes anyway.
function parseToUnicode(
  text: string,
  bytesPerCode: 1 | 2,
): Map<number, string> | null {
  const tokens = tokenizeCMap(text);
  if (!tokens) return null;
  const map = new Map<number, string>();

  const hexAt = (index: number): Uint8Array | null => {
    const token = tokens[index];
    return token && token.kind === "hex" ? hexToBytes(token.value) : null;
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.kind !== "keyword") continue;

    if (token.value === "endbfchar" || token.value === "endbfrange") {
      // An end without its begin means we mis-tracked sections — bail.
      return null;
    }

    if (token.value === "beginbfchar") {
      i += 1;
      while (i < tokens.length) {
        const current = tokens[i]!;
        if (current.kind === "keyword" && current.value === "endbfchar") break;
        const src = hexAt(i);
        const dst = hexAt(i + 1);
        if (!src || !dst) return null;
        const value = utf16beToString(dst);
        if (value === null) return null;
        if (src.length === bytesPerCode) map.set(bytesToCode(src), value);
        i += 2;
      }
      if (i >= tokens.length) return null;
    } else if (token.value === "beginbfrange") {
      i += 1;
      while (i < tokens.length) {
        const current = tokens[i]!;
        if (current.kind === "keyword" && current.value === "endbfrange") break;
        const lo = hexAt(i);
        const hi = hexAt(i + 1);
        if (!lo || !hi || lo.length !== hi.length) return null;
        const loCode = bytesToCode(lo);
        const hiCode = bytesToCode(hi);
        if (hiCode < loCode || hiCode - loCode + 1 > MAX_RANGE_SPAN) {
          return null;
        }
        const matches = lo.length === bytesPerCode;
        const dstToken = tokens[i + 2];
        if (!dstToken) return null;
        if (dstToken.kind === "hex") {
          const dst = hexToBytes(dstToken.value);
          const base = dst && utf16beToString(dst);
          if (!dst || base === null || base.length === 0) return null;
          if (matches) {
            // The range increments the LAST UTF-16 unit of the destination.
            const head = base.slice(0, -1);
            const lastUnit = base.charCodeAt(base.length - 1);
            for (let code = loCode; code <= hiCode; code += 1) {
              map.set(
                code,
                head + String.fromCharCode(lastUnit + (code - loCode)),
              );
            }
          }
          i += 3;
        } else if (dstToken.kind === "arrayStart") {
          let j = i + 3;
          let code = loCode;
          while (j < tokens.length && tokens[j]!.kind !== "arrayEnd") {
            const dst = hexAt(j);
            if (!dst) return null;
            const value = utf16beToString(dst);
            if (value === null) return null;
            if (matches && code <= hiCode) map.set(code, value);
            code += 1;
            j += 1;
          }
          if (j >= tokens.length) return null;
          i = j + 1;
        } else {
          return null;
        }
      }
      if (i >= tokens.length) return null;
    }
  }
  return map;
}

function toUnicodeText(font: PDFDict): string | null {
  const raw = font.get(PDFName.of("ToUnicode"));
  const stream = raw instanceof PDFRef ? font.context.lookup(raw) : raw;
  if (!(stream instanceof PDFRawStream)) return null;
  const bytes = stream.dict.has(PDFName.of("Filter"))
    ? decodePDFRawStream(stream).decode()
    : stream.getContents();
  // CMap programs are ASCII PostScript; latin1 decoding is lossless here.
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

export function createSourceFontEncoder(
  font: PDFDict,
): SourceFontEncoder | null {
  try {
    const info = contentFontInfo(font);
    if (!info.ok) return null;

    const cmapText = toUnicodeText(font);
    if (cmapText === null) return null;
    const codeToUnicode = parseToUnicode(cmapText, info.bytesPerCode);
    if (codeToUnicode === null || codeToUnicode.size === 0) return null;

    // Invert to Unicode → code, single-code-point targets only. On
    // collisions (two codes for one character — common for space) the first
    // wins; any of them draws the same glyph shape.
    const unicodeToCode = new Map<string, number>();
    for (const [code, value] of codeToUnicode) {
      if (Array.from(value).length !== 1) continue;
      if (!unicodeToCode.has(value)) unicodeToCode.set(value, code);
    }
    if (unicodeToCode.size === 0) return null;

    const encodeLine = (text: string): EncodedLine | null => {
      const chars = Array.from(text);
      const bytes = new Uint8Array(chars.length * info.bytesPerCode);
      let widthEm = 0;
      for (let i = 0; i < chars.length; i += 1) {
        const code = unicodeToCode.get(chars[i]!);
        if (code === undefined) return null;
        if (info.bytesPerCode === 1) {
          bytes[i] = code;
        } else {
          bytes[i * 2] = (code >> 8) & 0xff;
          bytes[i * 2 + 1] = code & 0xff;
        }
        widthEm += info.widthOf(code) / 1000;
      }
      return { bytes, widthEm };
    };

    return { bytesPerCode: info.bytesPerCode, encodeLine };
  } catch {
    return null;
  }
}
