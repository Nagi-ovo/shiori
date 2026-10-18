import type { PageModel } from "../../pdf/model/types";
import { pdfToDisplay, rotatedSize } from "../../pdf/geometry/coords";
import { pdfPointToPageLocal } from "../../pdf/model/pageSpace";
import type { DisplayRect, TextRunDisplayBounds } from "./highlightRects";
import type { MappedTextGlyph } from "./glyphGeometry";

export type MarkupTextGeometry = {
  textDivs: HTMLElement[];
  textRuns: Array<TextRunDisplayBounds | null>;
  glyphs?: Array<MappedTextGlyph[] | null>;
  scale?: number;
};

/** Intersect by DOM boundary points, not Range.intersectsNode alone: that API
 * includes the next span when the selection ends at its offset zero. */
export function rangeInTextDiv(range: Range, div: HTMLElement): Range | null {
  const local = div.ownerDocument.createRange();
  local.selectNodeContents(div);
  try {
    if (range.compareBoundaryPoints(Range.START_TO_START, local) > 0) {
      local.setStart(range.startContainer, range.startOffset);
    }
    if (range.compareBoundaryPoints(Range.END_TO_END, local) < 0) {
      local.setEnd(range.endContainer, range.endOffset);
    }
    if (local.collapsed || !div.contains(local.commonAncestorContainer) || local.toString().length === 0) return null;
    return local;
  } catch { return null; }
}

function textOffset(div: HTMLElement, node: Node, offset: number): number {
  const prefix = div.ownerDocument.createRange();
  prefix.selectNodeContents(div);
  prefix.setEnd(node, offset);
  return prefix.toString().length;
}

export function glyphDisplayRect(
  glyph: MappedTextGlyph,
  page: PageModel,
  scale: number,
): DisplayRect {
  const corners = glyph.quad.map(p => pdfToDisplay(
    pdfPointToPageLocal(page, p), page.widthPt, page.heightPt, page.rotation, scale,
  ));
  const x = Math.min(...corners.map(p => p.x)), y = Math.min(...corners.map(p => p.y));
  return { x, y, w: Math.max(...corners.map(p => p.x)) - x,
    h: Math.max(...corners.map(p => p.y)) - y };
}

/** One geometry path for the live selection, tool drag and selection toolbar.
 * Work in displayed CSS pixels, including a temporarily CSS-scaled text layer.
 * Font advances are authoritative; DOM geometry is a per-span fallback only.
 */
export function markupRectsForRange(
  range: Range,
  geometry: MarkupTextGeometry,
  page: PageModel,
  scale: number,
  rootRect: Pick<DOMRect, "left" | "top">,
): DisplayRect[] {
  const out: DisplayRect[] = [];
  const size = rotatedSize(page.widthPt, page.heightPt, page.rotation);
  const width = size.width * scale, height = size.height * scale;
  for (let index = 0; index < geometry.textDivs.length; index += 1) {
    const div = geometry.textDivs[index]!;
    const local = rangeInTextDiv(range, div);
    if (!local) continue;
    const start = textOffset(div, local.startContainer, local.startOffset);
    const end = textOffset(div, local.endContainer, local.endOffset);
    const glyphs = geometry.glyphs?.[index];
    if (glyphs?.length) {
      const selected = glyphs.filter(glyph => glyph.start < end && glyph.endOffset > start);
      // TextContent's synthetic whitespace has no ink. Do not fall back to
      // the DOM and accidentally include an unselected neighbouring glyph.
      const blockers = glyphs.filter(glyph => glyph.start >= end || glyph.endOffset <= start)
        .map(g => glyphDisplayRect(g, page, scale));
      for (const rect of mergeRunCells(selected.map(g => glyphDisplayRect(g, page, scale)), blockers)) {
        const left = Math.max(0, rect.x), top = Math.max(0, rect.y);
        const right = Math.min(width, rect.x + rect.w), bottom = Math.min(height, rect.y + rect.h);
        if (right > left && bottom > top) out.push({ x: left, y: top, w: right - left, h: bottom - top });
      }
      continue;
    }
    // Unknown encodings/ActualText/vertical scripts retain native selection.
    // Read only the selected text node, excluding parent and endOfContent boxes.
    const all = div.ownerDocument.createRange();
    all.selectNodeContents(div);
    const full = all.getBoundingClientRect();
    const run = geometry.textRuns[index];
    const horizontal = run && (!run.dirAngleDeg || Math.abs(run.dirAngleDeg) < 0.01);
    for (const rect of Array.from(local.getClientRects())) {
      let x = rect.left - rootRect.left, y = rect.top - rootRect.top;
      let w = rect.width, h = rect.height;
      if (horizontal && full.width > 0) {
        // The original run is in layerScale pixels. Its ratio to the DOM's
        // full run is stable across both locale font fallback and CSS zoom.
        const fullWidthRatio = w / full.width;
        const leftRatio = (rect.left - full.left) / full.width;
        // Derive the display scale from the full page, supplied by the caller
        // through the run conversion rather than from rounded DOM bounds.
        const ratio = scale / (geometry.scale ?? scale);
        x = (run.x + leftRatio * run.w) * ratio;
        w = fullWidthRatio * run.w * ratio;
        y = run.y * ratio; h = run.h * ratio;
      }
      const left = Math.max(0, x), top = Math.max(0, y);
      const right = Math.min(width, x + w), bottom = Math.min(height, y + h);
      if (right > left && bottom > top && [left, right, top, bottom].every(Number.isFinite)) {
        out.push({ x: left, y: top, w: right - left, h: bottom - top });
      }
    }
  }
  return out;
}

// Join adjacent selected cells on one baseline. Different font sizes and
// vertical positions retain their own bands; columns and large gaps stay open.
function mergeRunCells(rects: DisplayRect[], blockers: DisplayRect[]): DisplayRect[] {
  const out: DisplayRect[] = [];
  for (const rect of [...rects].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const last = out.at(-1);
    if (last && Math.abs(last.y - rect.y) < 0.01 && Math.abs(last.h - rect.h) < 0.01 &&
      rect.x - (last.x + last.w) <= Math.min(last.h, rect.h) * 0.6 &&
      !blockers.some(b => b.x < rect.x && b.x + b.w > last.x + last.w &&
        b.y < rect.y + rect.h && b.y + b.h > rect.y)) {
      last.w = Math.max(last.x + last.w, rect.x + rect.w) - last.x;
    } else out.push({ ...rect });
  }
  return out;
}

export type GlyphCaret = { node: Text; offset: number };

/** Mouse drags use the painted glyph cells for hit testing. Preserve native
 * DOM Selection for copying, keyboard navigation, touch handles and AT. */
export function glyphCaretAtPoint(
  geometry: MarkupTextGeometry,
  page: PageModel,
  scale: number,
  p: { x: number; y: number },
): GlyphCaret | null {
  let best: { distance: number; caret: GlyphCaret | null } | null = null;
  for (let i = 0; i < geometry.textDivs.length; i += 1) {
    const node = geometry.textDivs[i]!.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) continue;
    for (const glyph of geometry.glyphs?.[i] ?? []) {
      const rect = glyphDisplayRect(glyph, page, scale);
      const dx = Math.max(rect.x - p.x, 0, p.x - rect.x - rect.w);
      const dy = Math.max(rect.y - p.y, 0, p.y - rect.y - rect.h);
      // Require the pointer to be on the text's line, not on a figure or in
      // an unrelated column. Whitespace within a word is still selectable.
      if (dy > Math.min(rect.h * 0.5, 8 * scale) || dx > rect.h) continue;
      const start = pdfToDisplay(pdfPointToPageLocal(page, glyph.origin), page.widthPt, page.heightPt, page.rotation, scale);
      const end = pdfToDisplay(pdfPointToPageLocal(page, glyph.end), page.widthPt, page.heightPt, page.rotation, scale);
      const vx = end.x - start.x, vy = end.y - start.y;
      const denominator = vx * vx + vy * vy;
      const after = denominator > 0 && ((p.x - start.x) * vx + (p.y - start.y) * vy) / denominator > 0.5;
      const distance = dx * dx + dy * dy;
      if (!best || distance < best.distance || (glyph.nativeCaret && distance === best.distance)) best = {
        distance,
        caret: glyph.nativeCaret ? null : { node: node as Text, offset: after ? glyph.endOffset : glyph.start },
      };
    }
  }
  return best?.caret ?? null;
}
