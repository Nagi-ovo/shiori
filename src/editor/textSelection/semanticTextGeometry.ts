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
  const baselineDelta = Math.abs(previousTransform[5]! - currentTransform[5]!);
  if (baselineDelta > height * 0.25) return false;
  const gap = currentTransform[4]! - (previousTransform[4]! + previous.width);
  return gap >= -height && gap <= height * 0.3;
}

type VisualTextLine = {
  first: RuntimeTextItem;
  last: RuntimeTextItem;
  left: number;
  right: number;
  baselineY: number;
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
  return (
    height > 0 &&
    Math.abs(previousTransform[5]! - currentTransform[5]!) <= height * 0.25
  );
}

function visualTextLine(items: RuntimeTextItem[]): VisualTextLine | null {
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let height = 0;
  let baselineY: number | null = null;
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
    const x = transform[4]!;
    const itemRight = x + item.width;
    left = Math.min(left, x, itemRight);
    right = Math.max(right, x, itemRight);
    baselineY ??= transform[5]!;
    height = Math.max(height, semanticItemHeight(item));
  }
  if (
    !Number.isFinite(left) ||
    !Number.isFinite(right) ||
    baselineY === null ||
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
