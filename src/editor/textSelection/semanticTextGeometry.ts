// Geometry heuristics behind the semantic text join: whether two PDF text
// items continue one visual run, and which line ends are soft wraps. Split
// out of semanticText.ts, which consumes them.
import type {
  PdfTextItem as TextItem,
  PdfTextMarkedContent as TextMarkedContent,
} from "../../pdf/engine/text";

export type RuntimeTextItem = TextItem & {
  /** Replacement text (/ActualText) where the text content carries it. The
   * PDFium adapter emits none yet (src/pdf/engine/pdfiumText.ts). */
  actualText?: unknown;
};

export type RuntimeTextMarkedContent = TextMarkedContent & {
  actualText?: unknown;
  tag?: unknown;
};

export type RuntimeTextContentItem = RuntimeTextItem | RuntimeTextMarkedContent;

export function isTextItem(item: RuntimeTextContentItem): item is RuntimeTextItem {
  return typeof (item as Partial<TextItem>).str === "string";
}

export function preferredText(item: RuntimeTextItem): string {
  return maybeActualText(item) ?? item.str;
}

export function maybeActualText(item: { actualText?: unknown }): string | null {
  return typeof item.actualText === "string" ? item.actualText : null;
}

export function textItemsAreVisuallyContiguous(
  previous: RuntimeTextItem | null,
  current: RuntimeTextItem,
): boolean | undefined {
  if (
    !previous
  ) {
    return false;
  }
  if (
    previous.hasEOL ||
    /\s$/u.test(preferredText(previous)) ||
    /^\s/u.test(preferredText(current))
  ) {
    return false;
  }
  const previousTransform = previous.transform;
  const currentTransform = current.transform;
  if (
    !Array.isArray(previousTransform) ||
    !Array.isArray(currentTransform) ||
    previousTransform.length < 6 ||
    currentTransform.length < 6 ||
    !previousTransform.every(Number.isFinite) ||
    !currentTransform.every(Number.isFinite) ||
    !Number.isFinite(previous.width) ||
    !Number.isFinite(current.width)
  ) {
    return undefined;
  }
  const previousHeight = semanticItemHeight(previous);
  const currentHeight = semanticItemHeight(current);
  const height = Math.max(previousHeight, currentHeight);
  if (!(height > 0)) return undefined;
  // Measured along and across the previous item's baseline, so text drawn
  // under a rotated matrix joins exactly as it would upright.
  const dir = baselineDirection(previousTransform);
  if (!sameDirection(dir, baselineDirection(currentTransform))) return undefined;
  const from = inBaselineFrame(dir, previousTransform);
  const to = inBaselineFrame(dir, currentTransform);
  const baselineDelta = Math.abs(from.across - to.across);
  if (baselineDelta > height * 0.25) return false;
  // Right-to-left items advance leftward: the gap is before the previous one.
  const gap =
    previous.dir === "rtl" && current.dir === "rtl"
      ? from.along - (to.along + current.width)
      : to.along - (from.along + previous.width);
  return gap >= -height && gap <= height * 0.3;
}

type BaselineDirection = { x: number; y: number };

/** The unit advance direction of an item's text matrix; +x when degenerate. */
function baselineDirection(transform: number[]): BaselineDirection {
  const length = Math.hypot(transform[0]!, transform[1]!);
  return length > 0 ? { x: transform[0]! / length, y: transform[1]! / length } : { x: 1, y: 0 };
}

function sameDirection(a: BaselineDirection, b: BaselineDirection): boolean {
  return Math.abs(a.x * b.y - a.y * b.x) <= 1e-3 && a.x * b.x + a.y * b.y > 0;
}

/** An item's origin as distance along `dir` and across it (the baseline). */
function inBaselineFrame(
  dir: BaselineDirection,
  transform: number[],
): { along: number; across: number } {
  const x = transform[4]!;
  const y = transform[5]!;
  return { along: x * dir.x + y * dir.y, across: -x * dir.y + y * dir.x };
}

type VisualTextLine = {
  first: RuntimeTextItem;
  last: RuntimeTextItem;
  /** Along the first item's baseline direction `dir`. */
  left: number;
  right: number;
  /** Across that baseline. */
  baselineY: number;
  dir: BaselineDirection;
  height: number;
  text: string;
};

const SOFT_WRAP_MIN_LINE_ADVANCE_EM = 5;
const SOFT_WRAP_COLUMN_TOLERANCE_EM = 2;
const SOFT_WRAP_RIGHT_EDGE_TOLERANCE_EM = 2;

/**
 * `hasEOL` is emitted for visual wraps, paragraph endings, and column jumps.
 * Build complete visual lines first, then fail closed unless the previous line
 * looks like a filled line in the same local column. A line-end hyphen followed
 * by a letter/number is an explicit wrap signal and may be shorter.
 */
export function classifySoftLineContinuationStarts(
  items: RuntimeTextContentItem[],
): WeakSet<RuntimeTextItem> {
  const lines: Array<VisualTextLine | null> = [];
  let pending: RuntimeTextItem[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    lines.push(visualTextLine(pending));
    pending = [];
  };
  for (const item of items) {
    if (!isTextItem(item)) continue;
    const previousOnLine = pending.at(-1);
    if (previousOnLine && !textItemsShareVisualLine(previousOnLine, item)) {
      flush();
    }
    pending.push(item);
    if (item.hasEOL) flush();
  }
  flush();

  const softStarts = new WeakSet<RuntimeTextItem>();
  for (let index = 1; index < lines.length; index += 1) {
    const previous = lines[index - 1]!;
    const current = lines[index]!;
    if (!previous || !current) continue;
    if (!previous.last.hasEOL || previous.last.dir !== current.first.dir) continue;
    if (!sameDirection(previous.dir, current.dir)) continue;
    const height = Math.max(previous.height, current.height);
    if (!(height > 0)) continue;
    const baselineDelta = Math.abs(previous.baselineY - current.baselineY);
    if (baselineDelta < height * 0.5 || baselineDelta > height * 1.8) continue;

    // A true wrap returns to approximately the same column start. Requiring a
    // two-sided bound prevents a large leftward jump from a side column from
    // being mistaken for a line return.
    if (
      Math.abs(current.left - previous.left) >
        height * SOFT_WRAP_COLUMN_TOLERANCE_EM
    ) {
      continue;
    }

    const previousAdvance = previous.right - previous.left;
    const localRightEdge = Math.max(previous.right, current.right);
    const fillsLocalLine =
      previousAdvance >= height * SOFT_WRAP_MIN_LINE_ADVANCE_EM &&
      localRightEdge - previous.right <=
        height * SOFT_WRAP_RIGHT_EDGE_TOLERANCE_EM;
    const explicitHyphenWrap =
      /[-\u00ad\u2010\u2011]\s*$/u.test(previous.text) &&
      /^(?:\p{L}|\p{N})/u.test(current.text.trimStart());
    if (fillsLocalLine || explicitHyphenWrap) softStarts.add(current.first);
  }
  return softStarts;
}

function textItemsShareVisualLine(
  previous: RuntimeTextItem,
  current: RuntimeTextItem,
): boolean {
  const previousTransform = previous.transform;
  const currentTransform = current.transform;
  if (
    !Array.isArray(previousTransform) ||
    !Array.isArray(currentTransform) ||
    previousTransform.length < 6 ||
    currentTransform.length < 6 ||
    !previousTransform.every(Number.isFinite) ||
    !currentTransform.every(Number.isFinite)
  ) {
    return false;
  }
  const height = Math.max(
    semanticItemHeight(previous),
    semanticItemHeight(current),
  );
  const dir = baselineDirection(previousTransform);
  return (
    height > 0 &&
    sameDirection(dir, baselineDirection(currentTransform)) &&
    Math.abs(
      inBaselineFrame(dir, previousTransform).across -
        inBaselineFrame(dir, currentTransform).across,
    ) <= height * 0.25
  );
}

function visualTextLine(items: RuntimeTextItem[]): VisualTextLine | null {
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let height = 0;
  let baselineY: number | null = null;
  let dir: BaselineDirection | null = null;
  for (const item of items) {
    const transform = item.transform;
    if (
      !Array.isArray(transform) ||
      transform.length < 6 ||
      !transform.every(Number.isFinite) ||
      !Number.isFinite(item.width)
    ) {
      return null;
    }
    dir ??= baselineDirection(transform);
    const origin = inBaselineFrame(dir, transform);
    const x = origin.along;
    const itemRight = x + item.width;
    left = Math.min(left, x, itemRight);
    right = Math.max(right, x, itemRight);
    baselineY ??= origin.across;
    height = Math.max(height, semanticItemHeight(item));
  }
  if (
    !Number.isFinite(left) ||
    !Number.isFinite(right) ||
    baselineY === null ||
    dir === null ||
    !(right > left) ||
    !(height > 0)
  ) {
    return null;
  }
  return {
    first: items[0]!,
    last: items[items.length - 1]!,
    left,
    right,
    baselineY,
    dir,
    height,
    text: items.map(preferredText).join(""),
  };
}

function semanticItemHeight(item: RuntimeTextItem): number {
  if (Number.isFinite(item.height) && item.height > 0) return item.height;
  const transform = item.transform;
  return Array.isArray(transform) && transform.length >= 4
    ? Math.hypot(transform[2] ?? 0, transform[3] ?? 0)
    : 0;
}
