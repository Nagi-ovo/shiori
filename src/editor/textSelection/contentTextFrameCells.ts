// Glyph geometry of an edit as the page paints it. The text layer reads the
// written page (useContentTextPageReader: every committed edit applied), so
// its engine glyphs are what is on screen. A click that re-opens an edited
// block maps against them, including gaps a writer keeps in place and rows
// it wraps, rather than against a CSS layout of the text. Glyphs are matched
// to the edit's text by content; any mismatch (a stale layer, another
// text in the region) refuses rather than guesses.
import type { PdfTextGlyph } from "../../pdf/engine/text";
import { pdfToDisplay } from "../../pdf/geometry/coords";
import { pdfPointToPageLocal } from "../../pdf/model/pageSpace";
import type { ContentTextOverlay, PageModel } from "../../pdf/model/types";
import { isRtlText, type CaretCell, type CaretLine } from "./contentTextCaret";

/** Offsets of each glyph's characters in `text`, in order, whitespace the
 * writer leaves undrawn skipped; null unless every non-space character of
 * `text` is accounted for by exactly the glyphs given. */
export function alignGlyphs(text: string, glyphs: readonly PdfTextGlyph[]): Array<{ start: number; end: number }> | null {
  const out: Array<{ start: number; end: number }> = [];
  let at = 0;
  const skip = () => { while (at < text.length && /\s/.test(text[at]!)) at += 1; };
  for (const g of glyphs) {
    const drawn = g.text.replace(/\s+/g, "");
    if (!drawn) continue;
    skip();
    if (!text.startsWith(drawn, at)) return null;
    out.push({ start: at, end: at + drawn.length });
    at += drawn.length;
  }
  skip();
  return at === text.length ? out : null;
}

/** Caret rows of an edit as `glyphs` (the written page's, in PDF space)
 * paint it, in display space at `scale`; null unless they spell its text. */
export function writtenCaretLines(
  edit: Pick<ContentTextOverlay, "text" | "rect" | "coverRects" | "fontSize">,
  page: PageModel,
  scale: number,
  glyphs: readonly PdfTextGlyph[],
): CaretLine[] | null {
  const pad = edit.fontSize / 2;
  // Vertical slack only: a neighbouring unedited glyph must stay outside.
  const region = [edit.rect, ...edit.coverRects].map((r) => ({ x: r.x, y: r.y - pad, w: r.w, h: r.h + 2 * pad }));
  const inside = glyphs.filter((g) => {
    const c = center(page, g);
    return region.some((r) => c.x >= r.x && c.x <= r.x + r.w && c.y >= r.y && c.y <= r.y + r.h);
  });
  const spans = alignGlyphs(edit.text, inside);
  if (!spans?.length) return null;
  const placed = spans.map((span, i) => ({ ...span, glyph: inside[i]! }));
  const display = (p: { x: number; y: number }) => pdfToDisplay(pdfPointToPageLocal(page, p), page.widthPt, page.heightPt, page.rotation, scale);
  const cells: Array<CaretCell & { baseline: number }> = placed.map(({ start, end, glyph }) => {
    const corners = glyph.quad.map(display);
    const x = Math.min(...corners.map((p) => p.x)), y = Math.min(...corners.map((p) => p.y));
    const from = display(glyph.origin), to = display(glyph.end);
    return { start, end, rect: { x, y, w: Math.max(...corners.map((p) => p.x)) - x, h: Math.max(...corners.map((p) => p.y)) - y },
      from, to, rtl: isRtlText(glyph.text), baseline: from.y };
  });
  // Rows by baseline: a writer's wrap makes rows the text has no newline for.
  const rows: Array<CaretLine & { baseline: number }> = [];
  for (const cell of cells) {
    const row = rows.find((r) => Math.abs(r.baseline - cell.baseline) <= cell.rect.h / 2);
    if (row) { row.cells.push(cell); row.top = Math.min(row.top, cell.rect.y); row.bottom = Math.max(row.bottom, cell.rect.y + cell.rect.h); }
    else rows.push({ baseline: cell.baseline, top: cell.rect.y, bottom: cell.rect.y + cell.rect.h, cells: [cell] });
  }
  return rows.map(({ top, bottom, cells: rowCells }) => ({ top, bottom, cells: rowCells }));
}

function center(page: PageModel, g: PdfTextGlyph): { x: number; y: number } {
  const points = g.quad.length ? g.quad : [g.origin, g.end];
  const local = points.map((p) => pdfPointToPageLocal(page, p));
  return { x: local.reduce((s, p) => s + p.x, 0) / local.length, y: local.reduce((s, p) => s + p.y, 0) / local.length };
}
