import type { PdfPoint } from "../../pdf/model/types";
import type {
  PdfPageTextContent as TextContent,
  PdfTextGlyph,
  PdfTextItem as TextItem,
} from "../../pdf/engine/text";

export type { PdfTextGlyph };
export type MappedTextGlyph = PdfTextGlyph & {
  start: number;
  endOffset: number;
  // Bidi affinity depends on neighbouring runs, not just this glyph's
  // advance vector. Leave mouse caret placement to the browser in RTL runs.
  nativeCaret?: boolean;
};

/** Attach glyphs only when both their position and their text match a run.
 * TextContent inserts spaces for Tc/Tw/TJ, expands ligatures, and reorders
 * RTL text. Never interpolate an unmatched run into invented glyph positions.
 */
export function mapTextContentGlyphs(
  content: TextContent,
  glyphs: PdfTextGlyph[],
): Array<MappedTextGlyph[] | null> {
  const byFont = new Map<string, PdfTextGlyph[]>();
  for (const glyph of glyphs) {
    const list = byFont.get(glyph.fontName) ?? [];
    list.push(glyph); byFont.set(glyph.fontName, list);
  }
  return content.items.filter((item): item is TextItem => "str" in item).map(item => {
    if (!item.str.trim() || content.styles[item.fontName]?.vertical) return null;
    const [a, b, c, d, e, f] = item.transform as number[];
    const determinant = a! * d! - b! * c!;
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-10) return null;
    const runWidth = item.width / Math.hypot(a!, b!);
    const local = (p: PdfPoint) => ({
      x: (d! * (p.x - e!) - c! * (p.y - f!)) / determinant,
      y: (-b! * (p.x - e!) + a! * (p.y - f!)) / determinant,
    });
    const inRun = (glyph: PdfTextGlyph) => {
      const start = local(glyph.origin), end = local(glyph.end);
      const center = (start.x + end.x) / 2;
      return Math.abs(start.y) < 0.05 && Math.abs(end.y) < 0.05 &&
        start.x >= -0.01 && center <= runWidth + 0.01;
    };
    const match = (source: PdfTextGlyph[]) => {
      const candidates = source.filter(inRun).sort((g, h) => local(g.origin).x - local(h.origin).x);
      return matchGlyphText(item.str, candidates) ??
        (item.dir === "rtl" ? matchGlyphText(item.str, [...candidates].reverse()) : null);
    };
    // PDF.js can coalesce text across equivalent font resource IDs (links
    // in an otherwise plain line are a common example). Its item's fontName
    // then only identifies the first resource. Text + position still must
    // match completely before accepting the cross-resource candidate.
    const matched = match(byFont.get(item.fontName) ?? []) ?? match(glyphs);
    return matched?.map(glyph => ({ ...glyph, nativeCaret: item.dir === "rtl" })) ?? null;
  });
}

function matchGlyphText(text: string, glyphs: PdfTextGlyph[]): MappedTextGlyph[] | null {
  let offset = 0;
  const out: MappedTextGlyph[] = [];
  for (const glyph of glyphs) {
    if (!glyph.text.trim()) continue;
    while (/\s/u.test(text[offset] ?? "") && offset < text.length) offset += 1;
    if (offset === text.length) break;
    const value = text.startsWith(glyph.text, offset) ? glyph.text : glyph.text.normalize("NFKC");
    if (!text.startsWith(value, offset)) return null;
    out.push({ ...glyph, start: offset, endOffset: offset + value.length });
    offset += value.length;
  }
  return text.slice(offset).trim() === "" && out.length ? out : null;
}
