import type { PdfRect } from "../model/types";

const EDGE_TOLERANCE_PT = 0.001;
const MIN_RECT_SIZE_PT = 0;

type Interval = { x1: number; x2: number };
type Band = { y1: number; y2: number; intervals: Interval[] };

export function coalescePdfRects(rects: PdfRect[]): PdfRect[] {
  return buildBands(cleanRects(rects))
    .flatMap((band) =>
      mergeIntervals(band.intervals).map((interval) => ({
        x: round(interval.x1),
        y: round(band.y1),
        w: round(interval.x2 - interval.x1),
        h: round(band.y2 - band.y1),
      })),
    )
    .filter((rect) => rect.w > MIN_RECT_SIZE_PT && rect.h > MIN_RECT_SIZE_PT)
    .sort((a, b) => b.y - a.y || a.x - b.x);
}

function cleanRects(rects: PdfRect[]): PdfRect[] {
  return rects
    .map((rect) => ({
      x: round(rect.x),
      y: round(rect.y),
      w: round(rect.w),
      h: round(rect.h),
    }))
    .filter((rect) => Object.values(rect).every(Number.isFinite) && rect.w > MIN_RECT_SIZE_PT && rect.h > MIN_RECT_SIZE_PT);
}

function buildBands(rects: PdfRect[]): Band[] {
  const bands: Band[] = [];
  for (const rect of [...rects].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const y1 = rect.y;
    const y2 = rect.y + rect.h;
    const band = bands.find((candidate) => sameLineRange(y1, y2, candidate));
    if (!band) {
      bands.push({ y1, y2, intervals: [intervalOf(rect)] });
      continue;
    }
    band.y1 = Math.min(band.y1, y1);
    band.y2 = Math.max(band.y2, y2);
    band.intervals.push(intervalOf(rect));
  }
  return bands;
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.x1 - b.x1 || a.x2 - b.x2);
  const out: Interval[] = [];
  for (const interval of sorted) {
    const last = out.at(-1);
    if (!last || interval.x1 > last.x2 + EDGE_TOLERANCE_PT) {
      out.push({ ...interval });
    } else {
      last.x2 = Math.max(last.x2, interval.x2);
    }
  }
  return out;
}

function sameLineRange(y1: number, y2: number, band: Band): boolean {
  // Sharing part of a vertical band is not enough: combining different
  // fonts, superscripts or columns would paint previously unselected areas.
  return Math.abs(y1 - band.y1) < EDGE_TOLERANCE_PT &&
    Math.abs(y2 - band.y2) < EDGE_TOLERANCE_PT;
}

function intervalOf(rect: PdfRect): Interval {
  return { x1: rect.x, x2: rect.x + rect.w };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
