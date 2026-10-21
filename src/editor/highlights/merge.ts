import type {
  HighlightOverlay,
  Overlay,
  OverlayTextAnchor,
  PdfRect,
  StrikeOutOverlay,
  UnderlineOverlay,
} from "../../pdf/model/types";
import { coalescePdfRects } from "../../pdf/geometry/rectCoalesce";

const LINE_OVERLAP_EPS_PT = 0.1;
const LINE_OVERLAP_RATIO = 0.5;
const EDGE_TOLERANCE_PT = 0.001;
const MIN_RECT_SIZE_PT = 0.001;

type HighlightGesture = {
  type?: TextMarkupOverlay["type"];
  overlays: Overlay[];
  pageId: string;
  rects: PdfRect[];
  color: string;
  opacity: number;
  makeId: () => string;
  /**
   * Text-anchor provenance for THIS gesture's selection. Attached to the
   * result only when the gesture stands alone — a markup that merged with
   * existing ones covers more text than the selection, so the anchor would
   * lie. Any overlay whose rects this gesture reshapes (merge absorb, erase,
   * different-color subtract) loses its own anchor for the same reason.
   */
  anchor?: OverlayTextAnchor;
};

type HighlightGestureResult = {
  overlays: Overlay[];
  selectedId: string | null;
  changed: boolean;
};

type Interval = { x1: number; x2: number };
type Band = { y1: number; y2: number; intervals: Interval[] };
type TextMarkupOverlay = HighlightOverlay | UnderlineOverlay | StrikeOutOverlay;

export function applyHighlightGesture({
  type = "highlight",
  overlays,
  pageId,
  rects,
  color,
  opacity,
  makeId,
  anchor,
}: HighlightGesture): HighlightGestureResult {
  const newRects = cleanRects(rects);
  if (newRects.length === 0) {
    return { overlays, selectedId: null, changed: false };
  }

  const candidates = overlays.filter(
    (overlay): overlay is TextMarkupOverlay =>
      overlay.type === type &&
      overlay.pageId === pageId &&
      !overlay.locked &&
      !hasReviewProvenance(overlay),
  );
  const sameColorCandidates = candidates.filter((overlay) =>
    sameColor(overlay.color, color),
  );

  if (
    sameColorCandidates.length > 0 &&
    rectsContainedBy(
      newRects,
      sameColorCandidates.flatMap((overlay) => overlay.rects),
    )
  ) {
    let changed = false;
    const candidatesById = new Map(
      sameColorCandidates.map((overlay) => [overlay.id, overlay]),
    );
    const nextOverlays = overlays.flatMap((overlay) => {
      const markup = candidatesById.get(overlay.id);
      if (!markup) return [overlay];
      const nextRects = subtractRects(markup.rects, newRects);
      if (rectListsEqual(markup.rects, nextRects)) return [markup];
      changed = true;
      if (nextRects.length === 0) return [];
      // Erasing part of an anchored markup: the geometry no longer covers
      // the anchored text, so the provenance dies with the erased span.
      return [withoutAnchor({ ...markup, rects: nextRects })];
    });
    return { overlays: changed ? nextOverlays : overlays, selectedId: null, changed };
  }

  const touched = connectedHighlights(sameColorCandidates, newRects);

  const id = makeId();
  const replacement: TextMarkupOverlay = {
    type,
    id,
    pageId,
    rects: coalesceLineRects([
      ...newRects,
      ...touched.flatMap((overlay) => overlay.rects),
    ]),
    color,
    opacity,
    // A merged result spans more text than this gesture's selection; only a
    // stand-alone markup can honestly claim the selection as its anchor.
    ...(anchor && touched.length === 0 ? { anchor } : {}),
  } as TextMarkupOverlay;

  const touchedIds = new Set(touched.map((overlay) => overlay.id));
  const nextOverlays = overlays.flatMap((overlay) => {
    if (touchedIds.has(overlay.id)) return [];
    if (
      overlay.type !== type ||
      overlay.pageId !== pageId ||
      overlay.locked ||
      hasReviewProvenance(overlay) ||
      sameColor(overlay.color, color)
    ) {
      return [overlay];
    }
    const nextRects = subtractRects(overlay.rects, replacement.rects);
    if (rectListsEqual(overlay.rects, nextRects)) return [overlay];
    if (nextRects.length === 0) return [];
    // Same rule as the erase path: reshaped geometry orphans the anchor.
    return [withoutAnchor({ ...overlay, rects: nextRects })];
  });

  return {
    overlays: [...nextOverlays, replacement],
    selectedId: id,
    changed: true,
  };
}

export const coalesceLineRects = coalescePdfRects;

function hasReviewProvenance(overlay: TextMarkupOverlay): boolean {
  return Boolean(
    overlay.sourceAuthor ||
      overlay.sourceCreatedAt !== undefined ||
      overlay.sourceModifiedAt !== undefined ||
      overlay.sourceInReplyToId ||
      overlay.sourceReplyType ||
      // Merging would move the comment onto a new id or cut it with the
      // erased span.
      overlay.comment,
  );
}

function withoutAnchor<T extends TextMarkupOverlay>(overlay: T): T {
  if (!overlay.anchor) return overlay;
  const copy = { ...overlay };
  delete copy.anchor;
  return copy;
}

function subtractRects(existingRects: PdfRect[], cutters: PdfRect[]): PdfRect[] {
  const out: PdfRect[] = [];
  for (const rect of existingRects) {
    const cutterIntervals = cutters
      .filter((cutter) => sameLine(rect, cutter))
      .map((cutter) => intervalOf(cutter));
    if (cutterIntervals.length === 0) {
      out.push(rect);
      continue;
    }
    for (const interval of subtractIntervals(intervalOf(rect), cutterIntervals)) {
      out.push({
        x: round(interval.x1),
        y: rect.y,
        w: round(interval.x2 - interval.x1),
        h: rect.h,
      });
    }
  }
  return coalesceLineRects(out);
}

function rectsContainedBy(rects: PdfRect[], containers: PdfRect[]): boolean {
  const bands = buildBands(cleanRects(containers));
  if (bands.length === 0) return false;
  return rects.every((rect) => {
    const band = bands.find((candidate) => sameLineRange(rect.y, rect.y + rect.h, candidate));
    if (!band) return false;
    return intervalCovered(intervalOf(rect), mergeIntervals(band.intervals));
  });
}

function cleanRects(rects: PdfRect[]): PdfRect[] {
  return rects
    .map((rect) => ({
      x: round(rect.x),
      y: round(rect.y),
      w: round(rect.w),
      h: round(rect.h),
    }))
    .filter((rect) => rect.w > MIN_RECT_SIZE_PT && rect.h > MIN_RECT_SIZE_PT);
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

function subtractIntervals(base: Interval, cutters: Interval[]): Interval[] {
  let remaining = [{ ...base }];
  for (const cutter of mergeIntervals(cutters)) {
    remaining = remaining.flatMap((interval) => {
      const left = Math.max(interval.x1, cutter.x1);
      const right = Math.min(interval.x2, cutter.x2);
      if (right <= left + MIN_RECT_SIZE_PT) return [interval];
      const pieces: Interval[] = [];
      if (left - interval.x1 > MIN_RECT_SIZE_PT) {
        pieces.push({ x1: interval.x1, x2: left });
      }
      if (interval.x2 - right > MIN_RECT_SIZE_PT) {
        pieces.push({ x1: right, x2: interval.x2 });
      }
      return pieces;
    });
  }
  return remaining;
}

function intervalCovered(interval: Interval, containers: Interval[]): boolean {
  let cursor = interval.x1;
  for (const container of containers) {
    if (container.x2 < cursor - EDGE_TOLERANCE_PT) continue;
    if (container.x1 > cursor + EDGE_TOLERANCE_PT) return false;
    cursor = Math.max(cursor, container.x2);
    if (cursor >= interval.x2 - EDGE_TOLERANCE_PT) return true;
  }
  return false;
}

function rectsTouch(a: PdfRect, b: PdfRect): boolean {
  return (
    a.x <= b.x + b.w + EDGE_TOLERANCE_PT &&
    b.x <= a.x + a.w + EDGE_TOLERANCE_PT &&
    a.y <= b.y + b.h + EDGE_TOLERANCE_PT &&
    b.y <= a.y + a.h + EDGE_TOLERANCE_PT
  );
}

function connectedHighlights(
  candidates: TextMarkupOverlay[],
  rects: PdfRect[],
): TextMarkupOverlay[] {
  const touched: TextMarkupOverlay[] = [];
  const seen = new Set<string>();
  const frontier = [...rects];
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of candidates) {
      if (seen.has(candidate.id)) continue;
      if (!candidate.rects.some((rect) => frontier.some((other) => rectsTouch(rect, other)))) {
        continue;
      }
      seen.add(candidate.id);
      touched.push(candidate);
      frontier.push(...candidate.rects);
      changed = true;
    }
  }
  return touched;
}

function sameLine(a: PdfRect, b: PdfRect): boolean {
  return sameLineRange(a.y, a.y + a.h, { y1: b.y, y2: b.y + b.h, intervals: [] });
}

function sameLineRange(y1: number, y2: number, band: Band): boolean {
  const overlap = Math.min(y2, band.y2) - Math.max(y1, band.y1);
  const shorter = Math.min(y2 - y1, band.y2 - band.y1);
  return (
    overlap >= LINE_OVERLAP_EPS_PT &&
    overlap >= shorter * LINE_OVERLAP_RATIO
  );
}

function intervalOf(rect: PdfRect): Interval {
  return { x1: rect.x, x2: rect.x + rect.w };
}

function sameColor(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function rectListsEqual(a: PdfRect[], b: PdfRect[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((rect, index) => {
    const other = b[index];
    return (
      other &&
      rect.x === other.x &&
      rect.y === other.y &&
      rect.w === other.w &&
      rect.h === other.h
    );
  });
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
