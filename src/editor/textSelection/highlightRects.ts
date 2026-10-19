import type { PageModel, PdfRect } from "../../pdf/model/types";
import type {
  PdfPageTextContent as TextContent,
  PdfTextItem as TextItem,
  PdfTextStyle as TextStyle,
} from "../../pdf/engine/text";
import { displayRectToPdf, pdfToDisplay } from "../../pdf/geometry/coords";
import { pdfPointToPageLocal } from "../../pdf/model/pageSpace";
import { deterministicTextVerticalMetrics } from "../../pdf/geometry/textMetrics";

export type RectLike = Pick<DOMRect, "left" | "top" | "right" | "bottom">;
export type DisplayRect = { x: number; y: number; w: number; h: number };
export type TextRunDisplayBounds = DisplayRect & {
  text: string;
  // Display-space y of the glyph baseline (the text item's transform[5] through
  // the same page transform as x/y). The run's box is derived from estimated
  // ascent/descent, but the baseline itself is exact — downstream vertical
  // placement (contentText edit/render/export) must derive from it, not from
  // the box edges. Absent on runs built from DOM geometry (textDivDisplayRun),
  // which have no exact baseline; consumers must treat those as "don't know",
  // never estimate one.
  baselineY?: number;
  fontName?: string;
  fontFamily?: string;
  fontSizePt?: number;
  // Baseline advance direction in degrees (0 = horizontal left-to-right).
  // Absent on DOM-derived runs. See textItemToDisplayTextRun.
  dirAngleDeg?: number;
  cssFontFamily?: string;
  cssFontWeight?: string;
  cssFontStyle?: string;
  cssFontSizePt?: number;
};
export type TextOffsetSide = "start" | "end";

const MIN_TEXT_RECT_PX = 2;
const SAME_LINE_OVERLAP_RATIO = 0.5;
const SAME_RUN_GAP_RATIO = 0.6;
const MIN_RUN_GAP_PX = 2;
const MIN_CAP_OVERSHOOT_PX = 0.75;
const CAP_VERTICAL_OVERLAP_RATIO = 0.25;
const INLINE_EDGE_PADDING_RATIO = 0.12;
const MIN_INLINE_EDGE_PADDING_PX = 1.5;
const MAX_INLINE_EDGE_PADDING_PX = 5;
// Unicode ranges that flag a text run as containing CJK content. CJK
// runs disable horizontal padding entirely in
// `snapDisplayRectsToTextRuns` — see the comment there for why a
// padding heuristic doesn't work on title-sized CJK.
//   3000–303F  CJK Symbols and Punctuation (full-width 。 ， ！ ？ etc.)
//   3040–309F  Hiragana
//   30A0–30FF  Katakana
//   3400–4DBF  CJK Unified Ideographs Extension A
//   4E00–9FFF  CJK Unified Ideographs
//   F900–FAFF  CJK Compatibility Ideographs
//   FF00–FFEF  Halfwidth and Fullwidth Forms (full-width Latin, kana)

const CJK_CHAR_REGEX =
  /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/u;

type TextStyleLike = Pick<
  TextStyle,
  "ascent" | "descent" | "fontFamily" | "vertical"
>;
type VerticalTextMetrics = { ascentPx: number; descentPx: number };

// Browser `Range.getClientRects()` on the text layer returns rects
// sized to the inline line-box, which slightly overshoots the actual glyph
// extent — a few percent of leading above the cap line and a sliver of
// padding under the descender. macOS Preview, by contrast, writes
// `/QuadPoints` flush against the glyphs themselves. Without correction,
// Shiori-drawn highlights look noticeably taller than imported Preview
// highlights, and stacking the two on the same line shows the offset.
// When text-run geometry is unavailable, trim a small symmetric ratio from
// each merged band so Shiori-side rects collapse closer to Preview's visual
// bounds. Normal text markup is later snapped to glyph-aware TextItem
// geometry, which is the preferred path because it is based on PDF user-space
// metrics instead of browser selection line boxes.
const SHIORI_HIGHLIGHT_BAND_VERTICAL_TRIM_RATIO = 0.08;

let textMeasureContext: CanvasRenderingContext2D | null | undefined;

export function clientRectsToDisplayRects(
  rects: RectLike[],
  rootRect: RectLike,
  pageWidthPx: number,
  pageHeightPx: number,
): DisplayRect[] {
  const seen = new Set<string>();
  const out: DisplayRect[] = [];

  for (const rect of rects) {
    const left = clamp(rect.left - rootRect.left, 0, pageWidthPx);
    const right = clamp(rect.right - rootRect.left, 0, pageWidthPx);
    const top = clamp(rect.top - rootRect.top, 0, pageHeightPx);
    const bottom = clamp(rect.bottom - rootRect.top, 0, pageHeightPx);
    const x = Math.min(left, right);
    const y = Math.min(top, bottom);
    const w = Math.abs(right - left);
    const h = Math.abs(bottom - top);
    if (w < MIN_TEXT_RECT_PX || h < MIN_TEXT_RECT_PX) continue;

    const rounded: DisplayRect = {
      x: round(x),
      y: round(y),
      w: round(w),
      h: round(h),
    };
    const key = `${rounded.x}:${rounded.y}:${rounded.w}:${rounded.h}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rounded);
  }

  return mergeLineRects(out);
}

export function displayRectsToPdfRects(
  rects: DisplayRect[],
  page: PageModel,
  scale: number,
): PdfRect[] {
  return rects.map((rect) =>
    displayRectToPdf(
      rect,
      page.widthPt,
      page.heightPt,
      page.rotation,
      scale,
    ),
  );
}

export function textContentToDisplayTextRuns(
  textContent: TextContent,
  page: PageModel,
  scale: number,
  fontNames: Map<string, string> = new Map(),
): Array<TextRunDisplayBounds | null> {
  const runs: Array<TextRunDisplayBounds | null> = [];
  for (const item of textContent.items) {
    if (!isTextItem(item)) continue;
    runs.push(
      textItemToDisplayTextRun(
        item,
        page,
        scale,
        textContent.styles[item.fontName],
        fontNames.get(item.fontName),
      ),
    );
  }
  return runs;
}

export function snapDisplayRectsToTextRuns(
  rects: DisplayRect[],
  textRuns: TextRunDisplayBounds[],
): DisplayRect[] {
  if (rects.length === 0 || textRuns.length === 0) return rects;

  return rects.map((rect) => {
    const candidates = textRuns.filter((run) => sameVisibleLine(rect, run));
    if (candidates.length === 0) return rect;

    // Latin-only lines get a small inline pad on each side so a
    // browser-snapped DOM rect that ends a few pixels short of the
    // glyph cap still produces a flush highlight (and so trailing
    // whitespace is included).
    //
    // CJK-containing lines disable horizontal padding entirely.
    // Earlier versions tried per-side grid clamps and run-end caps,
    // but runtime testing on title-sized CJK showed the
    // 4.4–9px pad still visibly bleeds — the underlying problem is
    // that text-run metrics, the DOM text layer, and the
    // glyph ink boundary aren't tight enough to drive a numeric
    // padding heuristic. Take the native selection rect's
    // horizontal bounds as-is; only y/h come from the text run
    // band. Slight underfill on a true mid-glyph short selection
    // is the accepted runtime tradeoff — visible overflow on both
    // sides was worse. A future fix that wants to fill short
    // selections will need DOM Range / grapheme boundaries, not
    // more padding.
    const containsCjk = candidatesContainCjk(candidates);
    const edgePadding = containsCjk ? 0 : inlineEdgePadding(candidates);
    const rectRight = rect.x + rect.w;
    const runLeft = Math.min(...candidates.map((run) => run.x));
    const capRight = Math.max(...candidates.map((run) => run.x + run.w));
    const x = Math.max(0, Math.max(runLeft, rect.x - edgePadding));
    const paddedCapRight = Math.min(
      rectRight + edgePadding,
      capRight + edgePadding,
    );
    const right =
      rectRight - capRight >= MIN_CAP_OVERSHOOT_PX
        ? paddedCapRight
        : rectRight + edgePadding;
    const w = right - x;
    if (w < MIN_TEXT_RECT_PX) return rect;

    const y = Math.min(...candidates.map((run) => run.y));
    const bottom = Math.max(...candidates.map((run) => run.y + run.h));
    const h = bottom - y;
    if (h < MIN_TEXT_RECT_PX) return { ...rect, w: round(w) };

    return {
      x: round(x),
      y: round(y),
      w: round(w),
      h: round(h),
    };
  });
}

// The text layer renders headers, footers, and body text into the same flat
// text-layer container, so a native DOM selection from body text up
// into a header sweeps both into a single Range whose getClientRects
// covers both regions. Reject clusters separated from the gesture's
// anchor cluster by a vertical gap larger than ~2× the line height —
// paragraph spacing is < 2× line height, banner gaps are 3–10×.
//
// anchorY is the midpoint of the user's drag (or null if there's no
// gesture, in which case the median rect's Y stands in). Whichever
// cluster is closest to that anchor wins; the rest get dropped.
export function filterDistantClusters(
  rects: DisplayRect[],
  anchorY: number | null,
  gestureYRange: { minY: number; maxY: number } | null = null,
): DisplayRect[] {
  if (rects.length <= 1) return rects;
  const sorted = [...rects].sort((a, b) => a.y - b.y);
  const heights = sorted.map((r) => r.h).filter((h) => h > 0);
  if (heights.length === 0) return rects;
  const sortedHeights = [...heights].sort((a, b) => a - b);
  const medianHeight =
    sortedHeights[Math.floor(sortedHeights.length / 2)] ?? 16;
  const gapThreshold = medianHeight * 2;

  const clusters: DisplayRect[][] = [[sorted[0]!]];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1]!;
    const curr = sorted[i]!;
    const gap = curr.y - (prev.y + prev.h);
    if (gap > gapThreshold) clusters.push([curr]);
    else clusters[clusters.length - 1]!.push(curr);
  }
  if (clusters.length === 1) return rects;

  if (gestureYRange) {
    const spanMin = Math.min(gestureYRange.minY, gestureYRange.maxY);
    const spanMax = Math.max(gestureYRange.minY, gestureYRange.maxY);
    const clustersInGesture = clusters.filter((cluster) => {
      const minY = Math.min(...cluster.map((r) => r.y));
      const maxY = Math.max(...cluster.map((r) => r.y + r.h));
      return maxY >= spanMin && minY <= spanMax;
    });
    if (clustersInGesture.length > 0) return clustersInGesture.flat();
  }

  const fallbackAnchor = sorted[Math.floor(sorted.length / 2)]!.y;
  const anchor = anchorY ?? fallbackAnchor;
  let bestCluster = clusters[0]!;
  let bestDistance = Infinity;
  for (const cluster of clusters) {
    const minY = Math.min(...cluster.map((r) => r.y));
    const maxY = Math.max(...cluster.map((r) => r.y + r.h));
    const distance =
      anchor < minY ? minY - anchor : anchor > maxY ? anchor - maxY : 0;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestCluster = cluster;
    }
  }
  return bestCluster;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function textItemToDisplayTextRun(
  item: TextItem,
  page: PageModel,
  scale: number,
  style: TextStyleLike | undefined,
  pdfFontName: string | undefined,
): TextRunDisplayBounds | null {
  if (page.rotation !== 0) return null;
  if (item.dir === "ttb" || item.str.trim().length === 0) return null;
  if (style?.vertical) return null;

  const transform = item.transform.map(toFiniteNumber);
  if (transform.length < 6 || !transform.every(isNumber)) return null;
  const [a, b, c, d, e, f] = transform as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (!isFinitePositive(item.width)) return null;

  const fontHeightPt = firstFinitePositive(
    item.height,
    Math.hypot(c, d),
    Math.hypot(a, b),
  );
  if (fontHeightPt === null) return null;

  const startPoint = pdfPointToPageLocal(page, { x: e, y: f });
  const endPoint = { x: startPoint.x + item.width, y: startPoint.y };

  const start = pdfToDisplay(
    startPoint,
    page.widthPt,
    page.heightPt,
    page.rotation,
    scale,
  );
  const end = pdfToDisplay(
    endPoint,
    page.widthPt,
    page.heightPt,
    page.rotation,
    scale,
  );

  const x1 = Math.min(start.x, end.x);
  const x2 = Math.max(start.x, end.x);
  const fontHeightPx = fontHeightPt * scale;
  const metrics = textItemVerticalMetrics(item.str, fontHeightPx, style);
  const h = metrics.ascentPx + metrics.descentPx;
  if (x2 - x1 < MIN_TEXT_RECT_PX || h < MIN_TEXT_RECT_PX) return null;

  return {
    x: round(x1),
    y: round(start.y - metrics.ascentPx),
    w: round(x2 - x1),
    h: round(h),
    baselineY: start.y,
    text: item.str,
    fontName: pdfFontName ?? item.fontName,
    fontFamily: style?.fontFamily,
    fontSizePt: fontHeightPt,
    // Baseline advance direction from the text matrix, degrees, 0 =
    // horizontal. The box above is computed as if the run were horizontal
    // (item.width laid out along x), so consumers that group runs
    // geometrically (paragraph detection) must skip rotated runs — a 90°
    // margin stamp otherwise becomes a nonsense page-wide "line".
    // `|| 0` normalizes the -0 that atan2(-0, a) yields for plain
    // horizontal text.
    dirAngleDeg: round((Math.atan2(-b, a) * 180) / Math.PI) || 0,
  };
}

function isTextItem(item: TextContent["items"][number]): item is TextItem {
  return typeof (item as Partial<TextItem>).str === "string";
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function firstFinitePositive(...values: unknown[]): number | null {
  for (const value of values) {
    if (isFinitePositive(value)) return value;
  }
  return null;
}

// Title-sized CJK text in the text layer returns Range/client
// rects whose horizontal bounds are based on the typesetting advance
// box, not the glyph ink — a drag on "AB 栞示例" then claims a rect
// noticeably wider than the user's actual finger/pointer motion.
//
// `commitSelection` calls this to soft-clip the snapped rect when
// the rect is *significantly* wider than the user's gesture. The
// gate is `(rawWidth - gestureWidth) / rawWidth >= OVERFLOW_RATIO`:
// only "raw is at least 20 % wider than the gesture" earns a clip.
// Below that threshold we return the raw rect — runtime data
// showed those sub-threshold cases come from the user's drag
// landing inside the first/last char's cell, and clipping there
// visibly shortens what would otherwise be a correct selection.
// When we do clip we leave a small `margin` on each side so the
// highlight doesn't hard-snap to the gesture point — the user
// almost always intends the glyph cell that contains their drag
// boundary, not the cell only up to where their finger landed.
//
// Latin selections, keyboard selections (no gesture), and
// multi-line ranges are not clipped: Latin doesn't show the
// advance-vs-ink mismatch, keyboard selections have no gesture,
// and a single x-range can't be applied to multi-line rects.

// 0.20 came from runtime data: a clearly-too-wide title case was
// 21.3 %, the "looks fine" mid-overflow cases were 15.3 % and
// 4.7 %. The threshold sits between the worst no-clip case (15.3 %)
// and the smallest must-clip case (21.3 %).
const GESTURE_OVERFLOW_RATIO = 0.2;
// Per-side soft margin so the clip lands just past the gesture
// boundary rather than exactly on it. Scales with line height
// (≈ em width for CJK) but clamped so body and title both feel
// reasonable: never < 3px (would hard-snap on small text), never
// > 8px (would re-introduce visible bleed on title text).
const GESTURE_CLIP_MARGIN_RATIO = 0.06;
const GESTURE_CLIP_MARGIN_MIN_PX = 3;
const GESTURE_CLIP_MARGIN_MAX_PX = 8;

export function clipSnappedRectsToGesture(
  snapped: DisplayRect[],
  selectedRuns: TextRunDisplayBounds[],
  gestureStart: { x: number } | null,
  gestureEnd: { x: number } | null,
): DisplayRect[] {
  if (!gestureStart || !gestureEnd) return snapped;
  if (snapped.length !== 1) return snapped;
  if (!candidatesContainCjk(selectedRuns)) return snapped;
  const rect = snapped[0]!;
  const minX = Math.min(gestureStart.x, gestureEnd.x);
  const maxX = Math.max(gestureStart.x, gestureEnd.x);
  const gestureWidth = maxX - minX;
  if (gestureWidth < MIN_TEXT_RECT_PX) return snapped;
  if (rect.w <= 0) return snapped;
  const overRatio = (rect.w - gestureWidth) / rect.w;
  if (overRatio < GESTURE_OVERFLOW_RATIO) return snapped;
  const margin = Math.min(
    GESTURE_CLIP_MARGIN_MAX_PX,
    Math.max(GESTURE_CLIP_MARGIN_MIN_PX, rect.h * GESTURE_CLIP_MARGIN_RATIO),
  );
  const x = Math.max(rect.x, minX - margin);
  const right = Math.min(rect.x + rect.w, maxX + margin);
  if (right - x < MIN_TEXT_RECT_PX) return [];
  return [{ x, y: rect.y, w: right - x, h: rect.h }];
}

export function candidatesContainCjk(textRuns: TextRunDisplayBounds[]): boolean {
  for (const run of textRuns) {
    if (CJK_CHAR_REGEX.test(run.text)) return true;
  }
  return false;
}

export function normalizeDomTextOffsetX(
  run: TextRunDisplayBounds,
  domStartX: number,
  domEndX: number,
  domOffsetX: number,
): number {
  const domWidth = domEndX - domStartX;
  if (!Number.isFinite(domWidth) || domWidth <= 0 || run.w <= 0) {
    return clamp(domOffsetX, run.x, run.x + run.w);
  }
  const ratio = clamp((domOffsetX - domStartX) / domWidth, 0, 1);
  return run.x + run.w * ratio;
}

export function textOffsetForX(
  offsets: number[],
  x: number,
  side: TextOffsetSide,
): number {
  if (offsets.length <= 1) return 0;
  if (!Number.isFinite(x)) return 0;
  const lastOffset = offsets.length - 1;
  const firstX = offsets[0]!;
  if (x <= firstX) return 0;
  for (let i = 1; i < offsets.length; i += 1) {
    const boundary = offsets[i]!;
    if (side === "start") {
      if (x < boundary) return Math.max(0, i - 1);
    } else if (x <= boundary) {
      return i;
    }
  }
  return lastOffset;
}

// Only called for Latin-only candidates — CJK-containing rects skip
// horizontal padding entirely in `snapDisplayRectsToTextRuns`.
function inlineEdgePadding(textRuns: TextRunDisplayBounds[]): number {
  const maxHeight = Math.max(...textRuns.map((run) => run.h).filter((h) => h > 0));
  if (!Number.isFinite(maxHeight)) return MIN_INLINE_EDGE_PADDING_PX;
  return clamp(
    maxHeight * INLINE_EDGE_PADDING_RATIO,
    MIN_INLINE_EDGE_PADDING_PX,
    MAX_INLINE_EDGE_PADDING_PX,
  );
}

function textItemVerticalMetrics(
  text: string,
  fontHeightPx: number,
  style: TextStyleLike | undefined,
): VerticalTextMetrics {
  const measured = measureGlyphVerticalMetrics(text, fontHeightPx, style);
  if (measured) return measured;
  const metrics = deterministicTextVerticalMetrics(fontHeightPx, style);
  return { ascentPx: metrics.ascent, descentPx: metrics.descent };
}

function measureGlyphVerticalMetrics(
  text: string,
  fontHeightPx: number,
  style: TextStyleLike | undefined,
): VerticalTextMetrics | null {
  const ctx = getTextMeasureContext();
  if (!ctx || !style?.fontFamily) return null;
  ctx.font = `${fontHeightPx}px ${canvasFontFamily(style.fontFamily)}`;
  const metrics = ctx.measureText(text);
  const ascentPx = numberValue(metrics.actualBoundingBoxAscent);
  const descentPx = numberValue(metrics.actualBoundingBoxDescent);
  if (ascentPx === null || descentPx === null) return null;
  if (ascentPx + descentPx < MIN_TEXT_RECT_PX) return null;
  return { ascentPx, descentPx };
}

function getTextMeasureContext(): CanvasRenderingContext2D | null {
  if (textMeasureContext !== undefined) return textMeasureContext;
  if (typeof document === "undefined") {
    textMeasureContext = null;
    return textMeasureContext;
  }
  textMeasureContext = document.createElement("canvas").getContext("2d");
  return textMeasureContext;
}

function canvasFontFamily(fontFamily: string): string {
  const trimmed = fontFamily.trim();
  if (
    trimmed.includes(",") ||
    trimmed.startsWith("\"") ||
    trimmed.startsWith("'") ||
    !/\s/.test(trimmed)
  ) {
    return trimmed;
  }
  return JSON.stringify(trimmed);
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sameVisibleLine(rect: DisplayRect, run: TextRunDisplayBounds): boolean {
  const verticalOverlap =
    Math.min(rect.y + rect.h, run.y + run.h) - Math.max(rect.y, run.y);
  if (
    verticalOverlap <
    Math.min(rect.h, run.h) * CAP_VERTICAL_OVERLAP_RATIO
  ) {
    return false;
  }

  return rect.x < run.x + run.w && rect.x + rect.w > run.x;
}

function mergeLineRects(rects: DisplayRect[]): DisplayRect[] {
  const bands: Array<{ bounds: DisplayRect; rects: DisplayRect[] }> = [];

  for (const rect of [...rects].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const band = bands.find((candidate) => sameLine(candidate.bounds, rect));
    if (!band) {
      bands.push({ bounds: { ...rect }, rects: [{ ...rect }] });
      continue;
    }

    band.rects.push({ ...rect });
    const x1 = Math.min(band.bounds.x, rect.x);
    const y1 = Math.min(band.bounds.y, rect.y);
    const x2 = Math.max(band.bounds.x + band.bounds.w, rect.x + rect.w);
    const y2 = Math.max(band.bounds.y + band.bounds.h, rect.y + rect.h);
    band.bounds.x = x1;
    band.bounds.y = y1;
    band.bounds.w = round(x2 - x1);
    band.bounds.h = round(y2 - y1);
  }

  return bands.flatMap((band) =>
    mergeBandRuns(band.rects).map(trimBandHeight),
  );
}

function trimBandHeight(rect: DisplayRect): DisplayRect {
  const vTrim = rect.h * SHIORI_HIGHLIGHT_BAND_VERTICAL_TRIM_RATIO;
  const trimmedH = rect.h - vTrim * 2;
  if (trimmedH < MIN_TEXT_RECT_PX) return rect;
  return {
    x: rect.x,
    y: round(rect.y + vTrim),
    w: rect.w,
    h: round(trimmedH),
  };
}

function sameLine(a: DisplayRect, b: DisplayRect): boolean {
  const overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return overlap > Math.min(a.h, b.h) * SAME_LINE_OVERLAP_RATIO;
}

function mergeBandRuns(rects: DisplayRect[]): DisplayRect[] {
  const sorted = [...rects].sort((a, b) => a.x - b.x);
  const merged: DisplayRect[] = [];

  for (const rect of sorted) {
    const current = merged.at(-1);
    if (!current) {
      merged.push({ ...rect });
      continue;
    }

    const gap = rect.x - (current.x + current.w);
    const threshold = Math.max(
      MIN_RUN_GAP_PX,
      Math.min(current.h, rect.h) * SAME_RUN_GAP_RATIO,
    );
    if (gap > threshold) {
      merged.push({ ...rect });
      continue;
    }

    const x1 = Math.min(current.x, rect.x);
    const y1 = Math.min(current.y, rect.y);
    const x2 = Math.max(current.x + current.w, rect.x + rect.w);
    const y2 = Math.max(current.y + current.h, rect.y + rect.h);
    current.x = x1;
    current.y = y1;
    current.w = round(x2 - x1);
    current.h = round(y2 - y1);
  }

  return merged;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
