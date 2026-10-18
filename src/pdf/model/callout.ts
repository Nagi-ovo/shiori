import type {
  CalloutOverlay,
  PageModel,
  PdfPoint,
  PdfRect,
} from "./types";

export const CALLOUT_DEFAULT_COLOR = "#b13a2e";
export const CALLOUT_DEFAULT_FONT_SIZE_PT = 12;
export const CALLOUT_DEFAULT_WIDTH_PT = 144;
export const CALLOUT_DEFAULT_HEIGHT_PT = 54;
export const CALLOUT_PAGE_MARGIN_PT = 10;
export const CALLOUT_TARGET_OPACITY = 0.14;
export const CALLOUT_LABEL_PADDING_X_PT = 7;
export const CALLOUT_LABEL_PADDING_Y_PT = 5;
/**
 * Side of the square target a click-created callout points at. Roughly one
 * body character, so the leader lands on the spot the user clicked without the
 * tint reading as a highlighted region.
 */
export const CALLOUT_POINT_TARGET_PT = 12;

/**
 * What the page already contains, in PDF page space. Both lists are optional
 * because the two callers know different things: the interactive layer can see
 * the rendered text, the CLI/Live spec path cannot.
 */
export type CalloutEnvironment = {
  /** Label boxes of callouts already placed on this page. */
  occupiedRects?: readonly PdfRect[];
  /**
   * Body-text line boxes. Absent or empty means "we do not know where the text
   * is" — never "the page is blank" — so placement must not read emptiness here
   * as free space.
   */
  textRects?: readonly PdfRect[];
};

type CreateCalloutInput = {
  id: string;
  page: PageModel;
  targetRects: PdfRect[];
  text?: string;
  color?: string;
  fontSize?: number;
  rect?: PdfRect;
} & CalloutEnvironment;

export function createCalloutOverlay({
  id,
  page,
  targetRects,
  text = "",
  color = CALLOUT_DEFAULT_COLOR,
  fontSize = CALLOUT_DEFAULT_FONT_SIZE_PT,
  rect,
  occupiedRects = [],
  textRects = [],
}: CreateCalloutInput): CalloutOverlay {
  if (targetRects.length === 0) {
    throw new Error("A callout needs at least one target rectangle");
  }
  return {
    type: "callout",
    id,
    pageId: page.id,
    targetRects: targetRects.map((target) => ({ ...target })),
    rect:
      rect ??
      placeCalloutLabel(
        page,
        targetRects,
        { occupiedRects, textRects },
        {
          width: CALLOUT_DEFAULT_WIDTH_PT,
          height: CALLOUT_DEFAULT_HEIGHT_PT,
        },
      ),
    text,
    fontSize,
    color,
    bold: false,
    italic: false,
    align: "left",
    fontFamily: "sans",
  };
}

/**
 * Every term is a ratio, so the weights are comparable to each other instead of
 * to page units. That matters because `textRects` arrives as ~60 line boxes:
 * scoring raw overlap area would let body text outweigh running off the page.
 */
const CALLOUT_PLACEMENT_WEIGHTS = {
  /** Falling off the page stays the strongest signal by an order of magnitude. */
  clamp: 6,
  /** Sitting on the very text this callout quotes. */
  targetCover: 3,
  /** Sitting on another callout's label. */
  occupiedCover: 2,
  /** Sitting on body text. */
  textCover: 1,
  /** Edge-to-edge travel away from the quote. */
  gap: 0.6,
  /**
   * Vertical drift away from the quote's band. This is the marginalia rule
   * stated numerically: a note belongs beside the line it annotates. It has to
   * outweigh coverage, because a blank page margin has zero coverage from
   * anywhere on the page — without it a mid-page quote sends its label to the
   * page footer, and two quotes ten lines apart get wildly different homes.
   */
  verticalMiss: 2.6,
  /** Stable tiebreak so ties resolve identically across engines. */
  index: 1e-4,
} as const;

/**
 * Deterministic placement in PDF page space, persisted once at creation.
 *
 * Note the label is 144pt wide while a Letter page leaves ~62pt of usable outer
 * margin: it never fully fits beside the text column. So "avoid body text" is a
 * continuous least-bad-overlap cost, never a hard constraint.
 */
export function placeCalloutLabel(
  page: PageModel,
  targets: readonly PdfRect[],
  environment: CalloutEnvironment = {},
  size: { width: number; height: number } = {
    width: CALLOUT_DEFAULT_WIDTH_PT,
    height: CALLOUT_DEFAULT_HEIGHT_PT,
  },
): PdfRect {
  const occupiedRects = environment.occupiedRects ?? [];
  const textRects = environment.textRects ?? [];
  const target = unionPdfRects(targets)!;
  const w = Math.min(
    size.width,
    Math.max(24, page.widthPt - CALLOUT_PAGE_MARGIN_PT * 2),
  );
  const h = Math.min(
    size.height,
    Math.max(20, page.heightPt - CALLOUT_PAGE_MARGIN_PT * 2),
  );
  const rawCandidates: PdfRect[] = [
    ...ringCandidates(target, w, h),
    ...textAwareCandidates(page, target, textRects, w, h),
  ];

  const diagonal = Math.max(1, Math.hypot(page.widthPt, page.heightPt));
  const pageHeight = Math.max(1, page.heightPt);
  const weights = CALLOUT_PLACEMENT_WEIGHTS;

  let best = clampRectToPage(rawCandidates[0]!, page);
  let bestScore = Number.POSITIVE_INFINITY;
  rawCandidates.forEach((raw, index) => {
    const candidate = clampRectToPage(raw, page);
    const clampDistance =
      Math.abs(candidate.x - raw.x) + Math.abs(candidate.y - raw.y);
    // Per candidate, because a margin-hugging candidate is allowed to be
    // narrower than the default label: coverage must stay a fraction of the
    // box being judged, or the narrow one would look artificially clean.
    const labelArea = Math.max(1, candidate.w * candidate.h);
    // Clip to the label first, then normalize: "what share of my own box is on
    // ink". Line boxes barely overlap each other, so summing approximates the
    // union closely enough; saturating at 1 means "fully covered" either way.
    const cover = (rects: readonly PdfRect[]) =>
      Math.min(
        1,
        rects.reduce((sum, rect) => sum + overlapArea(candidate, rect), 0) /
          labelArea,
      );
    const verticalMiss = axisGap(
      candidate.y,
      candidate.y + candidate.h,
      target.y,
      target.y + target.h,
    );
    const score =
      (clampDistance / diagonal) * weights.clamp +
      cover([target]) * weights.targetCover +
      cover(occupiedRects) * weights.occupiedCover +
      cover(textRects) * weights.textCover +
      (rectGap(candidate, target) / diagonal) * weights.gap +
      (verticalMiss / pageHeight) * weights.verticalMiss +
      index * weights.index;
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  });
  return best;
}

/** The original eight-way ring around the quote. Order is load-bearing (ties). */
function ringCandidates(target: PdfRect, w: number, h: number): PdfRect[] {
  const gap = 18;
  const cx = target.x + target.w / 2;
  const cy = target.y + target.h / 2;
  return [
    { x: target.x + target.w + gap, y: cy - h / 2, w, h },
    { x: target.x - gap - w, y: cy - h / 2, w, h },
    { x: cx - w / 2, y: target.y + target.h + gap, w, h },
    { x: cx - w / 2, y: target.y - gap - h, w, h },
    { x: target.x + target.w + gap, y: target.y + target.h + gap, w, h },
    { x: target.x - gap - w, y: target.y + target.h + gap, w, h },
    { x: target.x + target.w + gap, y: target.y - gap - h, w, h },
    { x: target.x - gap - w, y: target.y - gap - h, w, h },
  ];
}

/**
 * Narrowest label worth offering. 54pt is about four CJK characters or nine
 * latin ones per line at the default 12pt — narrow, but that is what a real
 * margin note looks like. Below it a card reads as broken rather than tidy.
 */
const CALLOUT_MIN_MARGIN_WIDTH_PT = 54;

/**
 * Extra spots that only exist once we know where the text is: the two outer
 * margins at the quote's height (classic marginalia), plus the blank bands
 * above and below the whole text block.
 *
 * The margin candidates come in two widths — full, and narrowed to exactly the
 * free margin beside the text column. A 144pt card cannot fit a 62pt Letter
 * margin, but a 62pt card can, and an empty callout is about to grow its own
 * height to fit its text anyway.
 *
 * Deliberately only the *outer* bands. Text-free holes in the middle of a page
 * are overwhelmingly figures and tables, and nothing in this codebase extracts
 * image regions, so steering a label into one would be a worse regression than
 * the bug this fixes. If figure rects ever become available, feed them through
 * `textRects` — no signature change needed.
 */
function textAwareCandidates(
  page: PageModel,
  target: PdfRect,
  textRects: readonly PdfRect[],
  w: number,
  h: number,
): PdfRect[] {
  if (textRects.length === 0) return [];
  const margin = CALLOUT_PAGE_MARGIN_PT;
  const cx = target.x + target.w / 2;
  const cy = target.y + target.h / 2;
  const block = unionPdfRects(textRects)!;
  const candidates: PdfRect[] = [
    { x: margin, y: cy - h / 2, w, h },
    { x: page.widthPt - margin - w, y: cy - h / 2, w, h },
  ];
  const leftFree = block.x - margin;
  const rightFree = page.widthPt - margin - (block.x + block.w);
  if (leftFree >= CALLOUT_MIN_MARGIN_WIDTH_PT) {
    candidates.push({
      x: margin,
      y: cy - h / 2,
      w: Math.min(w, leftFree),
      h,
    });
  }
  if (rightFree >= CALLOUT_MIN_MARGIN_WIDTH_PT) {
    const narrow = Math.min(w, rightFree);
    candidates.push({
      x: page.widthPt - margin - narrow,
      y: cy - h / 2,
      w: narrow,
      h,
    });
  }
  // PDF y grows upward, so the "low" band sits beneath the last printed line.
  const bands: [number, number][] = [
    [margin, block.y],
    [block.y + block.h, page.heightPt - margin],
  ];
  bands.forEach(([lo, hi]) => {
    if (hi - lo < h) return;
    candidates.push({
      x: cx - w / 2,
      y: Math.min(hi - h, Math.max(lo, cy - h / 2)),
      w,
      h,
    });
  });
  return candidates;
}

/**
 * On-screen diameter of a collapsed callout's seal. Constant through the
 * everyday zoom band so it reads as a fixed marker, then growing sub-linearly
 * so it stays proportionate to the leader stroke at deep zoom.
 */
export function collapsedCalloutSizePx(scale: number): number {
  return Math.round(Math.min(40, Math.max(24, 14 * scale)));
}

/**
 * The seal is CONCENTRIC with the label it replaces, and that is load-bearing
 * rather than decorative: `calloutConnectorGeometry` derives both endpoints
 * from the label's centre, so keeping the centre fixed leaves the arrow end
 * bit-identical and slides the start along the same ray. The leader only gets
 * longer — it never swings — and the extra segment falls inside the old card's
 * own footprint, which is what lets the collapse animate without interpolating
 * the SVG path.
 */
export function collapsedCalloutRect(
  rect: PdfRect,
  sizePx: number,
  scale: number,
): PdfRect {
  const sizePt = sizePx / Math.max(0.01, scale);
  return {
    x: rect.x + rect.w / 2 - sizePt / 2,
    y: rect.y + rect.h / 2 - sizePt / 2,
    w: sizePt,
    h: sizePt,
  };
}

export type CalloutConnector = {
  kind: "polyline" | "quadratic";
  from: PdfPoint;
  control: PdfPoint;
  to: PdfPoint;
  arrowLeft: PdfPoint;
  arrowRight: PdfPoint;
};

/**
 * One stable curved leader line. The id-derived bend avoids sterile straight
 * arrows without introducing random layout changes between renders/exports.
 */
export function calloutConnectorGeometry(
  callout: Pick<
    CalloutOverlay,
    "id" | "rect" | "targetRects" | "leader" | "leaderKind"
  >,
): CalloutConnector {
  const explicit = callout.leader?.filter(
    (point) => Number.isFinite(point.x) && Number.isFinite(point.y),
  );
  if (explicit && (explicit.length === 2 || explicit.length === 3)) {
    const to = explicit[0]!;
    const from = explicit[explicit.length - 1]!;
    const control =
      explicit.length === 3
        ? explicit[1]!
        : { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    return connectorWithArrow(
      from,
      control,
      to,
      callout.leaderKind ?? "quadratic",
    );
  }
  const labelCenter = rectCenter(callout.rect);
  const target = nearestTargetRect(callout.targetRects, labelCenter);
  const targetCenter = rectCenter(target);
  const to = pointOnRectEdge(target, labelCenter);
  const from = pointOnRectEdge(callout.rect, targetCenter);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  const bendSign = stableHash(callout.id) % 2 === 0 ? 1 : -1;
  const bend = Math.min(22, Math.max(5, length * 0.12)) * bendSign;
  const control = {
    x: (from.x + to.x) / 2 + (-dy / length) * bend,
    y: (from.y + to.y) / 2 + (dx / length) * bend,
  };
  return connectorWithArrow(from, control, to, "quadratic");
}

function connectorWithArrow(
  from: PdfPoint,
  control: PdfPoint,
  to: PdfPoint,
  kind: CalloutConnector["kind"],
): CalloutConnector {
  // Quadratic derivative at t=1 points from control toward the target.
  const tx = to.x - control.x;
  const ty = to.y - control.y;
  const tangentLength = Math.max(1, Math.hypot(tx, ty));
  const ux = tx / tangentLength;
  const uy = ty / tangentLength;
  const arrowLength = 8;
  const arrowHalfWidth = 3.8;
  const base = {
    x: to.x - ux * arrowLength,
    y: to.y - uy * arrowLength,
  };
  return {
    kind,
    from,
    control,
    to,
    arrowLeft: {
      x: base.x - uy * arrowHalfWidth,
      y: base.y + ux * arrowHalfWidth,
    },
    arrowRight: {
      x: base.x + uy * arrowHalfWidth,
      y: base.y - ux * arrowHalfWidth,
    },
  };
}

export function unionPdfRects(rects: readonly PdfRect[]): PdfRect | null {
  if (rects.length === 0) return null;
  const x1 = Math.min(...rects.map((rect) => rect.x));
  const y1 = Math.min(...rects.map((rect) => rect.y));
  const x2 = Math.max(...rects.map((rect) => rect.x + rect.w));
  const y2 = Math.max(...rects.map((rect) => rect.y + rect.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function clampRectToPage(rect: PdfRect, page: PageModel): PdfRect {
  const minX = CALLOUT_PAGE_MARGIN_PT;
  const minY = CALLOUT_PAGE_MARGIN_PT;
  const maxX = Math.max(minX, page.widthPt - CALLOUT_PAGE_MARGIN_PT - rect.w);
  const maxY = Math.max(minY, page.heightPt - CALLOUT_PAGE_MARGIN_PT - rect.h);
  return {
    ...rect,
    x: Math.min(maxX, Math.max(minX, rect.x)),
    y: Math.min(maxY, Math.max(minY, rect.y)),
  };
}

function nearestTargetRect(rects: readonly PdfRect[], point: PdfPoint): PdfRect {
  return rects.reduce((best, rect) =>
    pointDistance(rectCenter(rect), point) <
    pointDistance(rectCenter(best), point)
      ? rect
      : best,
  );
}

function pointOnRectEdge(rect: PdfRect, toward: PdfPoint): PdfPoint {
  const center = rectCenter(rect);
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  if (dx === 0 && dy === 0) return center;
  const sx = dx === 0 ? Number.POSITIVE_INFINITY : rect.w / 2 / Math.abs(dx);
  const sy = dy === 0 ? Number.POSITIVE_INFINITY : rect.h / 2 / Math.abs(dy);
  const scale = Math.min(sx, sy);
  return { x: center.x + dx * scale, y: center.y + dy * scale };
}

function rectCenter(rect: PdfRect): PdfPoint {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

function pointDistance(a: PdfPoint, b: PdfPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Distance between two 1-D spans; zero when they touch or overlap. */
function axisGap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.max(a0 - b1, b0 - a1));
}

/** Edge-to-edge distance between two rects; zero when they intersect. */
function rectGap(a: PdfRect, b: PdfRect): number {
  return Math.hypot(
    axisGap(a.x, a.x + a.w, b.x, b.x + b.w),
    axisGap(a.y, a.y + a.h, b.y, b.y + b.h),
  );
}

function overlapArea(a: PdfRect, b: PdfRect): number {
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return w * h;
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
