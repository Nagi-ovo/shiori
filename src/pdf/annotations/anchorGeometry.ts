import type { PageModel, PdfRect } from "../model/types";
import type {
  PdfPageTextContent as TextContent,
  PdfTextItem as TextItem,
  PdfTextStyle as TextStyle,
} from "../engine/text";
import { pageOrigin } from "../model/pageSpace";
import { pdfiumItemGlyphs } from "../engine/pdfiumText";
import { deterministicTextVerticalMetrics } from "../geometry/textMetrics";
import {
  isSemanticGeometryContinuation,
  semanticRangeToUnitOffsets,
  type SemanticSearchIndex,
  type SemanticTextUnit,
} from "../../editor/textSelection/semanticText";

// Geometry for quote-anchored annotations, computed directly in PDF user
// space (page-local, origin bottom-left) from each text item's matrix. This
// deliberately does NOT reuse the display-space run builder in
// editor/textSelection/highlightRects.ts: that path bails on rotated pages
// and prefers canvas glyph measurement when a DOM exists. Anchor resolution
// runs in the app webview AND in the CLI (node), and a retried live
// operation must re-resolve to byte-identical overlays, so the math here
// must be environment-independent: style metrics or fixed ratios only,
// never canvas measurement.

export type PdfTextRun = {
  /** Page-local PDF-space box: y is baseline minus descent, h ascent+descent. */
  rect: PdfRect;
  /** Page-local PDF-space baseline, exact from the text matrix. */
  baselineYPt: number;
  /** The raw item text (item.str) the box covers. */
  text: string;
  /** UTF-16 offsets immediately after narrow curly quotes in a CJK run.
   * A number avoids one typed-array allocation for the common one-quote case.
   * Multiple offsets are sorted and queried by binary search. */
  narrowQuoteEndOffsets?: number | Uint32Array;
  /** The drawn glyphs, four numbers each: UTF-16 start and end in `text`,
   * then page-local left and right x. Absent when the text came without
   * glyph cells (only PDFium's page text carries them). */
  glyphCells?: Float64Array;
};

export type PdfTextRunMap = {
  runs: Array<PdfTextRun | null>;
  /** Whether the aligned text item contains visible source text. This lets
   * runtime-provided replacement spans distinguish harmless whitespace from
   * missing geometry. */
  visibleRuns: boolean[];
};

// Runs whose baselines differ by less than this fraction of the taller run's
// height sit on one visual line; adjacent same-line rects closer than the
// gap ratio merge into one quad.
const SAME_LINE_BASELINE_RATIO = 0.5;
const SAME_LINE_GAP_RATIO = 0.6;
const MIN_RUN_SIZE_PT = 0.05;
const BASELINE_ANGLE_EPSILON = 1e-6;
const NARROW_QUOTE_ADVANCE = 0.4;
const NARROW_QUOTE_ADJUSTMENT = 1 - NARROW_QUOTE_ADVANCE;
// A page with more than this many narrow quotes falls back to the old uniform
// slicing for overflowing runs. This caps the sparse index at 10k entries per
// page: multi-quote runs use at most 40 KiB of typed payload, while one-quote
// runs avoid an allocation and store one bounded number field.
export const MAX_NARROW_QUOTE_OFFSETS_PER_PAGE = 10_000;

/**
 * One entry per str-bearing text item, in text-div order — the SAME ordinal
 * that semanticText.ts assigns as divIndex, including whitespace-only items
 * (their entry is null). Keeping the arrays aligned is load-bearing: the
 * anchor resolver maps semantic units to geometry purely by that index.
 */
export function textContentToPdfRuns(
  textContent: TextContent,
  page: PageModel,
): Array<PdfTextRun | null> {
  return textContentToPdfRunMap(textContent, page).runs;
}

export function textContentToPdfRunMap(
  textContent: TextContent,
  page: PageModel,
): PdfTextRunMap {
  const styles = (textContent.styles ?? {}) as Record<string, TextStyle>;
  const runs: Array<PdfTextRun | null> = [];
  const visibleRuns: boolean[] = [];
  const quoteOffsetBudget = { remaining: MAX_NARROW_QUOTE_OFFSETS_PER_PAGE };
  for (const item of textContent.items) {
    if (!isTextItem(item)) continue;
    visibleRuns.push(
      item.str.trim().length > 0 &&
        !isSemanticGeometryContinuation(item.str),
    );
    runs.push(
      textItemToPdfRun(
        item,
        page,
        styles[item.fontName],
        quoteOffsetBudget,
      ),
    );
  }
  return { runs, visibleRuns };
}

function textItemToPdfRun(
  item: TextItem,
  page: PageModel,
  style: TextStyle | undefined,
  quoteOffsetBudget: { remaining: number },
): PdfTextRun | null {
  if (item.dir === "ttb" || item.str.trim().length === 0) return null;
  if (style?.vertical) return null;

  const transform = Array.isArray(item.transform) ? item.transform : [];
  if (transform.length < 6 || !transform.every(isFiniteNumber)) return null;
  const [a, b, c, d, e, f] = transform as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  // Only horizontal baselines: the box below lays item.width out along +x,
  // which is nonsense for a rotated stamp. Such items stay unresolvable and
  // surface as a clear anchor error instead of a misplaced rectangle.
  if (Math.abs(Math.atan2(-b, a)) > BASELINE_ANGLE_EPSILON) return null;
  if (!isFinitePositive(item.width)) return null;

  const fontHeightPt = firstFinitePositive(
    item.height,
    Math.hypot(c, d),
    Math.hypot(a, b),
  );
  if (fontHeightPt === null) return null;

  const origin = pageOrigin(page);
  const baselineX = e - origin.x;
  const baselineY = f - origin.y;
  const metrics = deterministicTextVerticalMetrics(fontHeightPt, style);
  const h = metrics.ascent + metrics.descent;
  if (item.width < MIN_RUN_SIZE_PT || h < MIN_RUN_SIZE_PT) return null;

  return {
    rect: {
      x: roundPt(baselineX),
      y: roundPt(baselineY - metrics.descent),
      w: roundPt(item.width),
      h: roundPt(h),
    },
    baselineYPt: roundPt(baselineY),
    text: item.str,
    ...narrowQuoteOffsets(item.str, quoteOffsetBudget),
    ...glyphCellsOf(item, origin.x),
  };
}

function glyphCellsOf(item: TextItem, originX: number): Pick<PdfTextRun, "glyphCells"> {
  const glyphs = pdfiumItemGlyphs(item);
  if (!glyphs?.length) return {};
  const cells = new Float64Array(glyphs.length * 4);
  glyphs.forEach((glyph, index) => {
    const left = Math.min(glyph.origin.x, glyph.end.x) - originX;
    const right = Math.max(glyph.origin.x, glyph.end.x) - originX;
    cells.set([glyph.start, glyph.endOffset, left, right], index * 4);
  });
  return { glyphCells: cells };
}

/** The x extent of the glyphs overlapping [startOffset, endOffset), or null
 * when none do. Cells are in increasing offset order. */
function glyphCellSpan(
  cells: Float64Array,
  startOffset: number,
  endOffset: number,
  consumeWork: ((amount: number) => void) | undefined,
): { left: number; right: number } | null {
  let low = 0;
  let high = cells.length / 4;
  while (low < high) {
    consumeWork?.(1);
    const middle = (low + high) >>> 1;
    if (cells[middle * 4 + 1]! <= startOffset) low = middle + 1;
    else high = middle;
  }
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  for (let i = low * 4; i < cells.length && cells[i]! < endOffset; i += 4) {
    consumeWork?.(1);
    left = Math.min(left, cells[i + 2]!);
    right = Math.max(right, cells[i + 3]!);
  }
  return right > left ? { left, right } : null;
}

export type CharRangeRects = {
  /** Merged page-local rects covering the range, reading order, top first. */
  rects: PdfRect[];
  /** Units inside the range that carry visible text but have no usable
   * geometry (vertical text, rotated baseline, degenerate box). */
  unresolvedUnits: number;
};

type LineRect = { rect: PdfRect; baselineYPt: number };

export type ActualTextGeometryCacheEntry = {
  lineRects: LineRect[];
  unresolved: boolean;
};

export type CharRangeGeometryOptions = {
  maxRects?: number;
  consumeWork?: (amount: number) => void;
  actualTextGeometryCache?: Map<number, ActualTextGeometryCacheEntry>;
};

export class AnchorGeometryLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnchorGeometryLimitError";
  }
}

/**
 * Map a char range of the semantic search text (the exact text findMatches
 * runs over) to page-local PDF rects. Sub-item coverage spans the matched
 * glyph cells when the run carries them (PDFium page text); otherwise it is
 * clipped proportionally along the run, the in-app highlighter's fallback.
 */
export function charRangeToPageRects(
  range: { start: number; end: number },
  index: SemanticSearchIndex,
  units: SemanticTextUnit[],
  runs: Array<PdfTextRun | null>,
  visibleRuns: readonly boolean[] = [],
  options: CharRangeGeometryOptions = {},
): CharRangeRects {
  const byUnit = semanticRangeToUnitOffsets(index, range, {
    consumeWork: options.consumeWork,
  });

  const lineRects: LineRect[] = [];
  const maxRects = options.maxRects ?? Number.POSITIVE_INFINITY;
  const pushLineRect = (entry: LineRect) => {
    options.consumeWork?.(1);
    if (lineRects.length >= maxRects) {
      throw new AnchorGeometryLimitError(
        `Anchor geometry exceeds ${maxRects} rectangles`,
      );
    }
    lineRects.push(entry);
  };
  let unresolvedUnits = 0;
  const unitIndexes = Array.from(byUnit.keys()).sort((a, b) => a - b);
  for (const unitIndex of unitIndexes) {
    options.consumeWork?.(1);
    const unit = units[unitIndex];
    const offsets = byUnit.get(unitIndex)!;
    if (!unit) continue;

    if (unit.kind === "actualText") {
      // Offsets address the replacement text, which has no glyph mapping;
      // cover the whole visual span the replacement stands for.
      let cached = options.actualTextGeometryCache?.get(unitIndex);
      if (!cached) {
        const actualLineRects: LineRect[] = [];
        let sawRun = false;
        let missingVisibleRun = false;
        for (let div = unit.startDivIndex; div <= unit.endDivIndex; div += 1) {
          options.consumeWork?.(1);
          const run = runs[div];
          if (!run) {
            if (visibleRuns[div] === true) missingVisibleRun = true;
            continue;
          }
          sawRun = true;
          if (actualLineRects.length >= maxRects) {
            throw new AnchorGeometryLimitError(
              `Anchor geometry exceeds ${maxRects} rectangles`,
            );
          }
          actualLineRects.push({
            rect: { ...run.rect },
            baselineYPt: run.baselineYPt,
          });
        }
        cached = {
          lineRects: actualLineRects,
          unresolved:
            (!sawRun || missingVisibleRun) && unit.text.trim().length > 0,
        };
        options.actualTextGeometryCache?.set(unitIndex, cached);
      }
      for (const entry of cached.lineRects) pushLineRect(entry);
      if (cached.unresolved) unresolvedUnits += 1;
      continue;
    }

    const covered = unit.text.slice(offsets.startOffset, offsets.endOffset);
    // Separator chars can map to whitespace-only units (e.g. a lone " "
    // item); they have no geometry of their own and need none.
    if (covered.trim().length === 0) continue;

    const run = runs[unit.divIndex];
    if (!run) {
      if (
        unit.joinWithPrevious &&
        isSemanticGeometryContinuation(unit.text) &&
        lineRects.length > 0
      ) {
        continue;
      }
      unresolvedUnits += 1;
      continue;
    }
    if (unit.text !== unit.rawText) {
      // Single-item ActualText replacement: offsets address the replacement
      // string, so proportional clipping against raw glyphs would misplace —
      // take the whole run.
      pushLineRect({ rect: { ...run.rect }, baselineYPt: run.baselineYPt });
      continue;
    }
    const glyphSpan = run.glyphCells
      ? glyphCellSpan(run.glyphCells, offsets.startOffset, offsets.endOffset, options.consumeWork)
      : null;
    if (glyphSpan) {
      pushLineRect({
        rect: {
          x: roundPt(glyphSpan.left),
          y: run.rect.y,
          w: roundPt(glyphSpan.right - glyphSpan.left),
          h: run.rect.h,
        },
        baselineYPt: run.baselineYPt,
      });
      continue;
    }
    const { startRatio, endRatio } = inlineSliceRatios(
      unit.text,
      run,
      offsets.startOffset,
      offsets.endOffset,
      options.consumeWork,
    );
    if (endRatio <= startRatio) continue;
    pushLineRect({
      rect: {
        x: roundPt(run.rect.x + run.rect.w * startRatio),
        y: run.rect.y,
        w: roundPt(run.rect.w * (endRatio - startRatio)),
        h: run.rect.h,
      },
      baselineYPt: run.baselineYPt,
    });
  }

  options.consumeWork?.(lineRects.length);
  return { rects: mergeLineRects(lineRects), unresolvedUnits };
}

/** Merge same-line neighbors so a sentence yields one quad per line instead
 * of one per text item. Higher lines (larger y) come first. */
function mergeLineRects(
  entries: Array<{ rect: PdfRect; baselineYPt: number }>,
): PdfRect[] {
  if (entries.length === 0) return [];
  type Line = {
    baselineYPt: number;
    baselineTotal: number;
    maxHeight: number;
    entries: Array<{ rect: PdfRect; baselineYPt: number }>;
  };
  const byBaseline = [...entries].sort(
    (left, right) => right.baselineYPt - left.baselineYPt,
  );
  const lines: Line[] = [];
  for (const entry of byBaseline) {
    const current = lines[lines.length - 1];
    const threshold =
      Math.max(current?.maxHeight ?? 0, entry.rect.h) *
      SAME_LINE_BASELINE_RATIO;
    if (
      current &&
      Math.abs(current.baselineYPt - entry.baselineYPt) <= threshold
    ) {
      current.entries.push(entry);
      current.baselineTotal += entry.baselineYPt;
      current.baselineYPt = current.baselineTotal / current.entries.length;
      current.maxHeight = Math.max(current.maxHeight, entry.rect.h);
    } else {
      lines.push({
        baselineYPt: entry.baselineYPt,
        baselineTotal: entry.baselineYPt,
        maxHeight: entry.rect.h,
        entries: [entry],
      });
    }
  }

  const output: PdfRect[] = [];
  for (const line of lines) {
    const leftToRight = [...line.entries].sort(
      (left, right) => left.rect.x - right.rect.x,
    );
    const merged: PdfRect[] = [];
    for (const entry of leftToRight) {
      const current = merged[merged.length - 1];
      if (current) {
        const tallest = Math.max(current.h, entry.rect.h);
        const gap = entry.rect.x - (current.x + current.w);
        if (gap <= tallest * SAME_LINE_GAP_RATIO) {
          const x = Math.min(current.x, entry.rect.x);
          const y = Math.min(current.y, entry.rect.y);
          const right = Math.max(
            current.x + current.w,
            entry.rect.x + entry.rect.w,
          );
          const top = Math.max(
            current.y + current.h,
            entry.rect.y + entry.rect.h,
          );
          current.x = roundPt(x);
          current.y = roundPt(y);
          current.w = roundPt(right - x);
          current.h = roundPt(top - y);
          continue;
        }
      }
      merged.push({ ...entry.rect });
    }
    output.push(...merged);
  }
  return output;
}

function isTextItem(item: TextContent["items"][number]): item is TextItem {
  return typeof (item as Partial<TextItem>).str === "string";
}

function clampRatio(value: number): number {
  return Math.max(0, Math.min(1, value));
}

const CJK_RUN_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u;
const NARROW_CURLY_QUOTE_RE = /[\u2018\u2019\u201c\u201d]/u;

/**
 * A TextItem carries one width, not per-glyph advances. Uniform
 * UTF-16 slicing visibly shifts a CJK quote when its combined item contains a
 * narrow curly quote. Keep the old uniform behavior for every other glyph;
 * only subtract the known narrow-quote delta from a precomputed sparse index.
 * Each boundary lookup is O(log quote count), charged to the caller's geometry
 * work budget, and never rescans the TextItem.
 */
function inlineSliceRatios(
  unitText: string,
  run: PdfTextRun,
  startOffset: number,
  endOffset: number,
  consumeWork: ((amount: number) => void) | undefined,
): { startRatio: number; endRatio: number } {
  const length = Math.max(1, unitText.length);
  // Offsets in a semantic unit address unit.text. Runtime item-level
  // ActualText (or any future replacement mapping) can differ from raw
  // TextItem.str, so its raw quote index is valid only for an exact mapping.
  const quoteOffsets =
    run.text === unitText ? run.narrowQuoteEndOffsets : undefined;
  if (quoteOffsets === undefined) {
    return {
      startRatio: clampRatio(startOffset / length),
      endRatio: clampRatio(endOffset / length),
    };
  }

  const quoteCount =
    typeof quoteOffsets === "number" ? 1 : quoteOffsets.length;
  const total = length - quoteCount * NARROW_QUOTE_ADJUSTMENT;
  if (!(total > 0)) {
    return {
      startRatio: clampRatio(startOffset / length),
      endRatio: clampRatio(endOffset / length),
    };
  }
  return {
    startRatio: clampRatio(
      adjustedOffset(quoteOffsets, startOffset, consumeWork) / total,
    ),
    endRatio: clampRatio(
      adjustedOffset(quoteOffsets, endOffset, consumeWork) / total,
    ),
  };
}

function adjustedOffset(
  quoteOffsets: number | Uint32Array,
  rawOffset: number,
  consumeWork: ((amount: number) => void) | undefined,
): number {
  if (typeof quoteOffsets === "number") {
    consumeWork?.(1);
    return rawOffset -
      (quoteOffsets <= rawOffset ? NARROW_QUOTE_ADJUSTMENT : 0);
  }
  let low = 0;
  let high = quoteOffsets.length;
  while (low < high) {
    consumeWork?.(1);
    const middle = (low + high) >>> 1;
    if (quoteOffsets[middle]! <= rawOffset) low = middle + 1;
    else high = middle;
  }
  return rawOffset - low * NARROW_QUOTE_ADJUSTMENT;
}

function narrowQuoteOffsets(
  text: string,
  budget: { remaining: number },
): Pick<PdfTextRun, "narrowQuoteEndOffsets"> {
  if (
    budget.remaining <= 0 ||
    !CJK_RUN_RE.test(text) ||
    !NARROW_CURLY_QUOTE_RE.test(text)
  ) {
    return {};
  }
  const offsets: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x2018 || code > 0x201d || code === 0x201a || code === 0x201b) {
      continue;
    }
    if (offsets.length >= budget.remaining) {
      // Do not retain a partial map: falling back to uniform slicing is safer
      // than calibrating the run against only some of its narrow quotes.
      return {};
    }
    offsets.push(index + 1);
  }
  if (offsets.length === 0) return {};
  budget.remaining -= offsets.length;
  return {
    narrowQuoteEndOffsets:
      offsets.length === 1 ? offsets[0] : Uint32Array.from(offsets),
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isFinitePositive(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function firstFinitePositive(...values: unknown[]): number | null {
  for (const value of values) {
    if (isFinitePositive(value)) return value;
  }
  return null;
}

/** Two decimals: sub-1/100pt precision is visual noise, and stable rounding
 * keeps resolved specs byte-identical across environments and retries. */
function roundPt(value: number): number {
  return Math.round(value * 100) / 100;
}
