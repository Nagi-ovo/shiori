/**
 * An embedded font rebuilt from the glyphs PDFium draws (shiori-core's
 * `FontOutlines`): what a page sets in it, in 1/1000 em, y up.
 */
export type PdfFontOutlines = {
  /** BaseFont, without a subset prefix, as the text layer names it. */
  name: string;
  flags: number;
  ascent: number;
  descent: number;
  /** Unicode, advance, and path data (`M`, `L`, `C`, `Z`, whole units). */
  glyphs: Array<[unicode: number, advance: number, path: string]>;
};

/** Reads shiori-core's `encode_font_outlines` JSON. */
export function decodeFontOutlines(bytes: Uint8Array): PdfFontOutlines[] {
  if (bytes.byteLength === 0) return [];
  return JSON.parse(new TextDecoder().decode(bytes)) as PdfFontOutlines[];
}

const UNITS_PER_EM = 1000;
const COMMAND = /([MLCZ])([^MLCZ]*)/g;

/**
 * An OpenType font (CFF outlines) holding these glyphs, mapped from their
 * characters, for a browser face. opentype.js writes every table a browser's
 * sanitiser checks; it loads only when a document needs a font rebuilt.
 */
export async function buildOutlineFont(font: PdfFontOutlines): Promise<ArrayBuffer> {
  const { Font, Glyph, Path } = await import("opentype.js");
  const glyphs = [new Glyph({ name: ".notdef", advanceWidth: UNITS_PER_EM / 2, path: new Path() })];
  let top = 0;
  let bottom = 0;
  for (const [unicode, advance, data] of font.glyphs) {
    const path = new Path();
    for (const [, command, args] of data.matchAll(COMMAND)) {
      const n = args!.trim() ? args!.trim().split(" ").map(Number) : [];
      for (let i = 1; i < n.length; i += 2) {
        top = Math.max(top, n[i]!);
        bottom = Math.min(bottom, n[i]!);
      }
      if (command === "M") path.moveTo(n[0]!, n[1]!);
      else if (command === "L") path.lineTo(n[0]!, n[1]!);
      else if (command === "C") path.curveTo(n[0]!, n[1]!, n[2]!, n[3]!, n[4]!, n[5]!);
      else path.close();
    }
    glyphs.push(
      new Glyph({
        name: `uni${unicode.toString(16).toUpperCase().padStart(4, "0")}`,
        unicode,
        advanceWidth: Math.max(0, advance),
        path,
      }),
    );
  }
  // The descriptor's metrics when the file gives them, else the outlines'.
  const ascender = Math.max(1, Math.round(font.ascent > 0 ? font.ascent : top));
  const descender = Math.min(0, Math.round(font.descent < 0 ? font.descent : bottom));
  return new Font({
    familyName: "Shiori PDF",
    styleName: "Regular",
    unitsPerEm: UNITS_PER_EM,
    ascender,
    descender,
    glyphs,
  }).toArrayBuffer();
}

/** A CSS unicode-range naming exactly these characters. */
export function unicodeRangeOf(codepoints: Iterable<number>): string {
  const sorted = [...new Set(codepoints)].sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j += 1;
    const hex = (cp: number) => cp.toString(16).toUpperCase();
    ranges.push(i === j ? `U+${hex(sorted[i]!)}` : `U+${hex(sorted[i]!)}-${hex(sorted[j]!)}`);
    i = j + 1;
  }
  return ranges.join(",");
}
