// The caret a plain click opens a source-text edit with: the grapheme
// boundary nearest the hit, on the line under it. Everything is in the page's
// display space, so the answer is the same at every zoom.
//
// Geometry comes from caret cells: the engine's glyph boxes and advances for
// source text (useContentTextSourceGeometry), the browser's layout for text
// already edited (contentTextDomCaret), or, for a run without either, widths
// measured once per grapheme and fitted to the run's source extent.
//
// Admission: the click tool only opens horizontal runs (|angle| <= 5°) of
// unrotated pages in horizontal writing; textContentToDisplayTextRuns and
// detectParagraphs refuse everything else, so no other axis reaches here.
// Within that, each cell carries its own advance and direction, so slightly
// tilted, right-to-left and mixed lines all resolve.
import type { DisplayRect, TextRunDisplayBounds } from "./highlightRects";
import { paragraphLineRuns, type DetectedLine } from "./paragraphDetect";

type Point = { x: number; y: number };
/** Painted extent of [start, end) in some text; from→to is the advance. */
export type CaretCell = { start: number; end: number; rect: DisplayRect; from: Point; to: Point; rtl: boolean };
export type CaretLine = { top: number; bottom: number; cells: CaretCell[] };
/** Advance of `text` set in `run`'s face, in any unit (only ratios matter). */
export type CaretMeasure = (text: string, run: TextRunDisplayBounds) => number;
/** Engine cells of a run, offsets relative to run.text; null when unmapped. */
export type RunCaretCells = (run: TextRunDisplayBounds) => readonly CaretCell[] | null;

const STRONG_RTL = /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;
const STRONG_LTR = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
let segmenter: Intl.Segmenter | null = null;

/** Grapheme clusters of `text` as [start, end) UTF-16 ranges. */
export function graphemes(text: string): Array<{ start: number; end: number; text: string }> {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return [...segmenter.segment(text)].map((s) => ({ start: s.index, end: s.index + s.segment.length, text: s.segment }));
}

export const isRtlText = (text: string) => STRONG_RTL.test(text);

/** The edit's text exactly as the block is opened with. */
export function paragraphBlockText(lines: readonly DetectedLine[], scale: number): string {
  return lines.map((line) => paragraphLineRuns(line, scale).text).join("\n");
}

/**
 * Offset into `text` of the grapheme boundary nearest `point`: the line is
 * chosen by vertical distance, the grapheme by distance to its painted cells,
 * the side by the point's place along their advance (reversed for
 * right-to-left text). Null when no line has a painted cell.
 */
export function caretInLines(lines: readonly CaretLine[], point: Point, text: string): number | null {
  const painted = lines.filter((line) => line.cells.length);
  if (!painted.length || !text.length) return null;
  const vertical = (line: CaretLine) => Math.max(line.top - point.y, 0, point.y - line.bottom);
  const line = painted.reduce((best, next) => (vertical(next) < vertical(best) ? next : best));
  // Group the line's cells by the cluster each touches: one pass over the
  // text and one over the cells, so long lines stay linear.
  const clusters = graphemes(text), clusterAt = new Int32Array(text.length + 1);
  clusters.forEach((c, i) => clusterAt.fill(i, c.start, c.end));
  const groups = new Map<number, CaretCell[]>();
  for (const cell of line.cells) {
    const first = clusterAt[Math.min(cell.start, text.length - 1)]!, last = clusterAt[Math.max(cell.start, cell.end - 1)]!;
    for (let i = first; i <= last; i += 1) groups.set(i, [...(groups.get(i) ?? []), cell]);
  }
  let best: { distance: number; offset: number } | null = null;
  for (const [index, cells] of groups) {
    const cluster = clusters[index]!;
    const x0 = Math.min(...cells.map((c) => c.rect.x)), x1 = Math.max(...cells.map((c) => c.rect.x + c.rect.w));
    const y0 = Math.min(...cells.map((c) => c.rect.y)), y1 = Math.max(...cells.map((c) => c.rect.y + c.rect.h));
    const dx = Math.max(x0 - point.x, 0, point.x - x1), dy = Math.max(y0 - point.y, 0, point.y - y1);
    const distance = dx * dx + dy * dy;
    if (best && distance >= best.distance) continue;
    // Place along the summed advance across the cluster's extent.
    const ux = cells.reduce((s, c) => s + c.to.x - c.from.x, 0), uy = cells.reduce((s, c) => s + c.to.y - c.from.y, 0);
    const norm = Math.hypot(ux, uy) || 1, u = { x: ux / norm, y: uy / norm };
    const along = (p: Point) => p.x * u.x + p.y * u.y;
    const corners = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => along({ x: x!, y: y! }));
    const min = Math.min(...corners), span = Math.max(...corners) - min || 1;
    const t = (along(point) - min) / span;
    const after = cells[0]!.rtl ? t < 0.5 : t > 0.5;
    best = { distance, offset: after ? cluster.end : cluster.start };
  }
  return best?.offset ?? null;
}

/** Caret lines of a detected block, offsets into paragraphBlockText. */
export function blockCaretLines(
  lines: readonly DetectedLine[],
  scale: number,
  measure: CaretMeasure = (text) => graphemes(text).length,
  cellsOf: RunCaretCells = () => null,
): CaretLine[] {
  let base = 0;
  return lines.map((line) => {
    const { text, starts } = paragraphLineRuns(line, scale);
    const cells = line.runs.flatMap((run, r) => {
      const at = base + starts[r]!;
      const own = cellsOf(run);
      return (own?.length ? own : measuredCells(run, measure)).map((c) => ({ ...c, start: c.start + at, end: c.end + at }));
    });
    base += text.length + 1;
    return { top: line.top, bottom: line.bottom, cells };
  });
}

/** Offset into paragraphBlockText(lines) nearest to `point`. */
export function contentTextCaretOffset(
  lines: readonly DetectedLine[],
  point: Point,
  scale: number,
  measure?: CaretMeasure,
  cellsOf?: RunCaretCells,
): number | null {
  return caretInLines(blockCaretLines(lines, scale, measure, cellsOf), point, paragraphBlockText(lines, scale));
}

/** Grapheme cells laid along the run's source extent by measured widths:
 * one measure per distinct grapheme, so linear in the run length. A run whose
 * first strong character is right-to-left is laid out from its right edge. */
function measuredCells(run: TextRunDisplayBounds, measure: CaretMeasure): CaretCell[] {
  const parts = graphemes(run.text), widths = new Map<string, number>();
  const width = (g: string) => {
    let w = widths.get(g);
    if (w === undefined) { w = Math.max(0, measure(g, run)); widths.set(g, w); }
    return w;
  };
  const sizes = parts.map((p) => width(p.text));
  const total = sizes.reduce((s, w) => s + w, 0);
  const strong = run.text.match(new RegExp(`${STRONG_RTL.source}|${STRONG_LTR.source}`, "u"))?.[0];
  const rtl = strong !== undefined && isRtlText(strong);
  const baseline = run.baselineY ?? run.y + run.h;
  let used = 0;
  return parts.map((p, i) => {
    const share = total > 0 ? sizes[i]! / total : 1 / parts.length;
    const lead = total > 0 ? used / total : i / parts.length;
    used += sizes[i]!;
    const a = rtl ? run.x + run.w * (1 - lead - share) : run.x + run.w * lead;
    const w = run.w * share;
    return { start: p.start, end: p.end, rect: { x: a, y: run.y, w, h: run.h },
      from: { x: a, y: baseline }, to: { x: a + w, y: baseline }, rtl };
  });
}

let canvas: HTMLCanvasElement | null = null;
/** CaretMeasure from the run's resolved CSS face (one unit each if none). */
export const canvasCaretMeasure: CaretMeasure = (text, run) => {
  canvas ??= document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context || !run.cssFontFamily) return graphemes(text).length;
  context.font = `${run.cssFontStyle ?? "normal"} ${run.cssFontWeight ?? "400"} 100px ${run.cssFontFamily}`;
  return context.measureText(text).width;
};
