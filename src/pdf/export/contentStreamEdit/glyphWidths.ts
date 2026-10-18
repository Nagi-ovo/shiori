// Font metrics for the glyph-removal export pass: advance widths, vertical
// extent, and code layout, read from the PDF font dictionaries only — glyph
// advance data lives in /Widths (simple fonts) or the descendant's /W + /DW
// (Type0), so no font-program parsing is needed.
//
// Anything this module can't model precisely returns { unsupported } and the
// caller must leave the page untouched: Type3 fonts (glyphs are content
// streams with their own space), vertical writing, and non-Identity CMaps
// (code→CID needs the CMap program). Guessing a width would silently corrupt
// hit-testing.

import type { PDFDict } from "pdf-lib";
import { PDFArray, PDFName, PDFNumber, PDFRef } from "pdf-lib";

export type ContentFontInfo = {
  ok: true;
  // How many bytes one glyph code occupies in show strings. 1 for simple
  // fonts; 2 for Type0/Identity-H (code == CID).
  bytesPerCode: 1 | 2;
  // Advance width in glyph space units (1/1000 em) for a glyph code.
  widthOf: (code: number) => number;
  // Em-relative vertical extent from the FontDescriptor (/1000), used for the
  // glyph hit-box. Defaults are the project's usual 0.8/-0.2 estimate.
  ascentEm: number;
  descentEm: number;
  // Word spacing (Tw) applies only to single-byte code 32 (PDF 32000
  // §9.3.3) — never to 2-byte codes.
  appliesWordSpacing: boolean;
};

export type UnsupportedFont = { ok: false; reason: string };

const DEFAULT_ASCENT_EM = 0.8;
const DEFAULT_DESCENT_EM = -0.2;

function lookup(dict: PDFDict, key: string): unknown {
  const raw = dict.get(PDFName.of(key));
  return raw instanceof PDFRef ? dict.context.lookup(raw) : raw;
}

function numberValue(value: unknown): number | null {
  return value instanceof PDFNumber ? value.asNumber() : null;
}

function nameValue(value: unknown): string | null {
  return value instanceof PDFName ? value.decodeText() : null;
}

function descriptorMetrics(descriptor: unknown): {
  ascentEm: number;
  descentEm: number;
  missingWidth: number;
} {
  if (!(descriptor instanceof Object) || !(descriptor as PDFDict).get) {
    return {
      ascentEm: DEFAULT_ASCENT_EM,
      descentEm: DEFAULT_DESCENT_EM,
      missingWidth: 0,
    };
  }
  const dict = descriptor as PDFDict;
  const ascent = numberValue(lookup(dict, "Ascent"));
  const descent = numberValue(lookup(dict, "Descent"));
  const missingWidth = numberValue(lookup(dict, "MissingWidth"));
  return {
    ascentEm:
      ascent !== null && ascent > 0 ? ascent / 1000 : DEFAULT_ASCENT_EM,
    descentEm:
      descent !== null && descent < 0 ? descent / 1000 : DEFAULT_DESCENT_EM,
    missingWidth: missingWidth ?? 0,
  };
}

function simpleFontInfo(font: PDFDict): ContentFontInfo | UnsupportedFont {
  const firstChar = numberValue(lookup(font, "FirstChar"));
  const widthsRaw = lookup(font, "Widths");
  if (firstChar === null || !(widthsRaw instanceof PDFArray)) {
    // Standard-14 fonts may omit widths; modeling their AFM tables is not
    // worth the risk surface. Bail.
    return { ok: false, reason: "simple font without /FirstChar + /Widths" };
  }
  const widths: number[] = [];
  for (let i = 0; i < widthsRaw.size(); i += 1) {
    const raw = widthsRaw.get(i);
    const resolved = raw instanceof PDFRef ? font.context.lookup(raw) : raw;
    const value = numberValue(resolved);
    if (value === null) return { ok: false, reason: "malformed /Widths entry" };
    widths.push(value);
  }
  const metrics = descriptorMetrics(lookup(font, "FontDescriptor"));
  return {
    ok: true,
    bytesPerCode: 1,
    widthOf: (code) => widths[code - firstChar] ?? metrics.missingWidth,
    ascentEm: metrics.ascentEm,
    descentEm: metrics.descentEm,
    appliesWordSpacing: true,
  };
}

// Parses a CIDFont /W array: sequences of either `c [w1 w2 …]` (consecutive
// widths from CID c) or `cFirst cLast w` (a range sharing one width).
function parseCidWidths(
  wArray: PDFArray,
  context: PDFDict["context"],
): { ranges: Array<{ first: number; last: number; widths: number[] | number }> } | null {
  const items: unknown[] = [];
  for (let i = 0; i < wArray.size(); i += 1) {
    const raw = wArray.get(i);
    items.push(raw instanceof PDFRef ? context.lookup(raw) : raw);
  }
  const ranges: Array<{ first: number; last: number; widths: number[] | number }> = [];
  let i = 0;
  while (i < items.length) {
    const first = numberValue(items[i]);
    if (first === null) return null;
    const second = items[i + 1];
    if (second instanceof PDFArray) {
      const widths: number[] = [];
      for (let j = 0; j < second.size(); j += 1) {
        const raw = second.get(j);
        const value = numberValue(
          raw instanceof PDFRef ? context.lookup(raw) : raw,
        );
        if (value === null) return null;
        widths.push(value);
      }
      ranges.push({ first, last: first + widths.length - 1, widths });
      i += 2;
    } else {
      const last = numberValue(second);
      const width = numberValue(items[i + 2]);
      if (last === null || width === null) return null;
      ranges.push({ first, last, widths: width });
      i += 3;
    }
  }
  return { ranges };
}

function type0FontInfo(font: PDFDict): ContentFontInfo | UnsupportedFont {
  const encoding = lookup(font, "Encoding");
  const encodingName = nameValue(encoding);
  if (encodingName !== "Identity-H") {
    return {
      ok: false,
      reason:
        encodingName === "Identity-V"
          ? "vertical writing mode"
          : "non-Identity CMap encoding",
    };
  }
  const descendants = lookup(font, "DescendantFonts");
  if (!(descendants instanceof PDFArray) || descendants.size() !== 1) {
    return { ok: false, reason: "malformed /DescendantFonts" };
  }
  const descendantRaw = descendants.get(0);
  const descendant =
    descendantRaw instanceof PDFRef
      ? font.context.lookup(descendantRaw)
      : descendantRaw;
  if (!(descendant instanceof Object) || !(descendant as PDFDict).get) {
    return { ok: false, reason: "unresolvable descendant font" };
  }
  const cidFont = descendant as PDFDict;
  const defaultWidth = numberValue(lookup(cidFont, "DW")) ?? 1000;
  const wRaw = lookup(cidFont, "W");
  let ranges: Array<{ first: number; last: number; widths: number[] | number }> = [];
  if (wRaw instanceof PDFArray) {
    const parsed = parseCidWidths(wRaw, font.context);
    if (parsed === null) return { ok: false, reason: "malformed /W array" };
    ranges = parsed.ranges;
  }
  const metrics = descriptorMetrics(lookup(cidFont, "FontDescriptor"));
  return {
    ok: true,
    bytesPerCode: 2,
    widthOf: (cid) => {
      for (const range of ranges) {
        if (cid >= range.first && cid <= range.last) {
          return typeof range.widths === "number"
            ? range.widths
            : range.widths[cid - range.first]!;
        }
      }
      return defaultWidth;
    },
    ascentEm: metrics.ascentEm,
    descentEm: metrics.descentEm,
    appliesWordSpacing: false,
  };
}

export function contentFontInfo(
  font: PDFDict,
): ContentFontInfo | UnsupportedFont {
  const subtype = nameValue(lookup(font, "Subtype"));
  switch (subtype) {
    case "Type1":
    case "MMType1":
    case "TrueType":
      return simpleFontInfo(font);
    case "Type0":
      return type0FontInfo(font);
    case "Type3":
      // Type3 glyphs are little content streams with their own glyph space;
      // widths exist but hit-testing their painted area honestly needs the
      // CharProcs. Bail.
      return { ok: false, reason: "Type3 font" };
    default:
      return { ok: false, reason: `unknown font subtype ${subtype ?? "(none)"}` };
  }
}
