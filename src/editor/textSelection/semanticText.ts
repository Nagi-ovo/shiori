import type {
  PdfPageTextContent as TextContent,
  PdfTextItem as TextItem,
  PdfTextMarkedContent as TextMarkedContent,
} from "../../pdf/engine/text";

type RuntimeTextItem = TextItem & {
  /** Replacement text (/ActualText) where the text content carries it. The
   * PDFium adapter emits none yet (src/pdf/engine/pdfiumText.ts). */
  actualText?: unknown;
};

type RuntimeTextMarkedContent = TextMarkedContent & {
  actualText?: unknown;
  tag?: unknown;
};

type RuntimeTextContentItem = RuntimeTextItem | RuntimeTextMarkedContent;

type ActualTextGroup = {
  actualText: string | null;
  outputIndex: number;
  startDivIndex: number | null;
  endDivIndex: number | null;
  hasEOL: boolean;
  joinWithPrevious: boolean | undefined;
  softLineBreakWithPrevious: boolean | undefined;
};

export type SemanticTextUnit =
  | {
      kind: "text";
      divIndex: number;
      text: string;
      rawText: string;
      hasEOL: boolean;
      joinWithPrevious?: boolean;
      softLineBreakWithPrevious?: boolean;
    }
  | {
      kind: "actualText";
      startDivIndex: number;
      endDivIndex: number;
      text: string;
      hasEOL: boolean;
      joinWithPrevious?: boolean;
      softLineBreakWithPrevious?: boolean;
    };

export type SemanticTextLayerModel = {
  textDivCount: number;
  units: SemanticTextUnit[];
};

export const MAX_SEMANTIC_CONTENT_ITEMS_PER_PAGE = 100_000;
export const MAX_SEMANTIC_SOURCE_CHARACTERS_PER_PAGE = 2_000_000;
export const MAX_SEMANTIC_SEARCH_SPANS_PER_PAGE = 50_000;
export const MAX_SEMANTIC_STYLES_PER_PAGE = 50_000;
export const MAX_SEMANTIC_MARKED_CONTENT_DEPTH = 1_000;

export class SemanticTextLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SemanticTextLimitError";
  }
}

export type BoundedTextContentOptions = {
  /** Caller-owned deadline/cancellation hook, checked while the engine reads
   * the page (PdfEngine.pageText). */
  checkAbort?: () => void;
};

export function semanticTextContentCost(textContent: TextContent): {
  items: number;
  sourceCharacters: number;
} {
  let sourceCharacters = 0;
  for (const item of textContent.items as RuntimeTextContentItem[]) {
    sourceCharacters += semanticTextItemCharacterCount(item);
  }
  return { items: textContent.items.length, sourceCharacters };
}

export type SemanticSearchSpan = {
  /** Half-open range in SemanticSearchIndex.text. */
  start: number;
  end: number;
  unitIndex: number;
  /** Half-open range in the source SemanticTextUnit.text. */
  unitStart: number;
  unitEnd: number;
};

export type SemanticSearchIndex = {
  text: string;
  /** Compact source mapping. One span covers a whole visible run instead of
   * allocating an object for every character in the page. */
  spans: SemanticSearchSpan[];
  /** Layout-only separators inserted between PDF text runs at a real line
   * break. Search may treat these separators (and a line-end wrap hyphen)
   * as optional while ranges remain mapped to the original source text. */
  layoutBreaks: SemanticLayoutBreak[];
  /** Paragraph/column/unknown EOL separators that matches must not cross. */
  hardBreaks: Array<{ start: number; end: number }>;
};

export type SemanticLayoutBreak = {
  /** Half-open separator range in `text`. */
  start: number;
  end: number;
  /** When present, a dehyphenated search variant may ignore from here. */
  dehyphenateStart?: number;
};

export type SemanticUnitOffsetRange = {
  startOffset: number;
  endOffset: number;
};

export function buildSemanticTextLayerModel(
  textContent: TextContent,
): SemanticTextLayerModel {
  assertSemanticTextContentWithinLimits(textContent);
  const softLineContinuationStarts = classifySoftLineContinuationStarts(
    textContent.items as RuntimeTextContentItem[],
  );
  const units: Array<SemanticTextUnit | null> = [];
  const groups: ActualTextGroup[] = [];
  let activeActualTextGroup: ActualTextGroup | null = null;
  let previousTextItem: RuntimeTextItem | null = null;
  let textDivCount = 0;

  for (const item of textContent.items as RuntimeTextContentItem[]) {
    if (isTextItem(item)) {
      const divIndex = textDivCount;
      textDivCount += 1;
      const joinWithPrevious = textItemsAreVisuallyContiguous(
        previousTextItem,
        item,
      );
      const softLineBreakWithPrevious = softLineContinuationStarts.has(item);
      const actualGroup = activeActualTextGroup;
      if (actualGroup) {
        actualGroup.startDivIndex ??= divIndex;
        actualGroup.endDivIndex = divIndex;
        actualGroup.hasEOL ||= item.hasEOL;
        if (actualGroup.startDivIndex === divIndex) {
          actualGroup.joinWithPrevious = joinWithPrevious;
          actualGroup.softLineBreakWithPrevious = softLineBreakWithPrevious;
        }
        previousTextItem = item;
        continue;
      }
      units.push({
        kind: "text",
        divIndex,
        text: preferredText(item),
        rawText: item.str,
        hasEOL: item.hasEOL,
        joinWithPrevious,
        ...(softLineBreakWithPrevious === true
          ? { softLineBreakWithPrevious: true }
          : {}),
      });
      previousTextItem = item;
      continue;
    }

    if (isMarkedContentBegin(item)) {
      const actualText = activeActualTextGroup === null ? maybeActualText(item) : null;
      const group: ActualTextGroup = {
        actualText,
        outputIndex: actualText !== null ? units.push(null) - 1 : -1,
        startDivIndex: null,
        endDivIndex: null,
        hasEOL: false,
        joinWithPrevious: undefined,
        softLineBreakWithPrevious: undefined,
      };
      groups.push(group);
      if (actualText !== null) activeActualTextGroup = group;
      continue;
    }

    if (item.type === "endMarkedContent") {
      const group = groups.pop();
      if (!group || group.actualText === null || group.outputIndex < 0) continue;
      if (activeActualTextGroup === group) activeActualTextGroup = null;
      if (group.startDivIndex === null || group.endDivIndex === null) {
        units[group.outputIndex] = null;
        continue;
      }
      units[group.outputIndex] = {
        kind: "actualText",
        startDivIndex: group.startDivIndex,
        endDivIndex: group.endDivIndex,
        text: group.actualText,
        hasEOL: group.hasEOL,
        joinWithPrevious: group.joinWithPrevious,
        ...(group.softLineBreakWithPrevious === true
          ? { softLineBreakWithPrevious: true }
          : {}),
      };
    }
  }

  return {
    textDivCount,
    units: units.filter((unit): unit is SemanticTextUnit => unit !== null),
  };
}

export function semanticTextContentToString(textContent: TextContent): string {
  return semanticUnitsToString(buildSemanticTextLayerModel(textContent).units, {
    preserveLineBreaks: false,
  });
}

export function semanticUnitsToString(
  units: SemanticTextUnit[],
  options: { preserveLineBreaks: boolean },
): string {
  if (!options.preserveLineBreaks) {
    return semanticUnitsToSearchIndex(units).text;
  }

  const chunks: string[] = [];
  let previous: SemanticTextUnit | null = null;
  for (const unit of units) {
    if (!unit.text) continue;
    if (previous) {
      if (previous?.hasEOL) {
        chunks.push("\n");
      } else if (!/\s$/u.test(previous.text) && !/^\s/u.test(unit.text)) {
        const previousCharacter = lastVisibleCodePoint(previous.text);
        const nextCharacter = firstVisibleChar(unit.text);
        if (
          !shouldJoinSemanticUnitBoundary(
            previous,
            unit,
            previousCharacter,
            nextCharacter,
          )
        ) {
          chunks.push(" ");
        }
      }
    }
    chunks.push(unit.text);
    previous = unit;
  }

  return normalizeSemanticText(chunks.join(""), true);
}

/** null means native copy is safe; an empty string is a deliberate semantic
 * replacement and must still suppress raw-glyph clipboard fallback. */
export function semanticClipboardTextForUnits(
  selectedUnits: SemanticTextUnit[],
): string | null {
  const hasSemanticReplacement = selectedUnits.some(
    (unit) =>
      unit.kind === "actualText" ||
      (unit.kind === "text" && unit.text !== unit.rawText),
  );
  if (!hasSemanticReplacement) return null;
  return semanticUnitsToString(selectedUnits, { preserveLineBreaks: true });
}

export function semanticUnitsToSearchIndex(
  units: SemanticTextUnit[],
): SemanticSearchIndex {
  if (units.length > MAX_SEMANTIC_CONTENT_ITEMS_PER_PAGE) {
    throw new SemanticTextLimitError(
      `Page text has ${units.length} semantic units; the safe limit is ${MAX_SEMANTIC_CONTENT_ITEMS_PER_PAGE}`,
    );
  }
  let sourceCharacters = 0;
  let spanUpperBound = 0;
  for (const unit of units) {
    sourceCharacters += unit.text.length;
    if (sourceCharacters > MAX_SEMANTIC_SOURCE_CHARACTERS_PER_PAGE) {
      throw new SemanticTextLimitError(
        `Page semantic text exceeds ${MAX_SEMANTIC_SOURCE_CHARACTERS_PER_PAGE} characters`,
      );
    }
    let previousWhitespace: boolean | null = null;
    for (let index = 0; index < unit.text.length; index += 1) {
      const whitespace = /\s/.test(unit.text[index] ?? "");
      if (whitespace !== previousWhitespace) {
        spanUpperBound += 1;
        previousWhitespace = whitespace;
        if (spanUpperBound > MAX_SEMANTIC_SEARCH_SPANS_PER_PAGE) {
          throw new SemanticTextLimitError(
            `Page semantic text exceeds ${MAX_SEMANTIC_SEARCH_SPANS_PER_PAGE} mapping spans`,
          );
        }
      }
    }
  }

  let text = "";
  const spans: SemanticSearchSpan[] = [];
  const layoutBreaks: SemanticLayoutBreak[] = [];
  const hardBreaks: Array<{ start: number; end: number }> = [];
  let previousUnit: SemanticTextUnit | null = null;

  const append = (
    chunk: string,
    unitIndex: number | null,
    unitStart = 0,
    unitEnd = unitStart + chunk.length,
  ) => {
    if (!chunk) return;
    const start = text.length;
    text += chunk;
    if (unitIndex !== null) {
      if (spans.length >= MAX_SEMANTIC_SEARCH_SPANS_PER_PAGE) {
        throw new SemanticTextLimitError(
          `Page semantic text exceeds ${MAX_SEMANTIC_SEARCH_SPANS_PER_PAGE} mapping spans`,
        );
      }
      spans.push({
        start,
        end: text.length,
        unitIndex,
        unitStart,
        unitEnd,
      });
    }
  };

  units.forEach((unit, unitIndex) => {
    if (!unit.text) return;
    // Geometry-aware units explicitly say whether they continue the previous
    // run. Older/manual units fall back to the CJK/grapheme heuristic. A real
    // EOL always wins so anchors cannot manufacture cross-line CJK matches.
    if (text.length > 0) {
      const prev = lastVisibleCodePoint(text);
      const next = firstVisibleChar(unit.text);
      if (
        previousUnit &&
        !shouldJoinSemanticUnitBoundary(previousUnit, unit, prev, next)
      ) {
        const breakStart = text.endsWith(" ") ? text.length - 1 : text.length;
        if (!text.endsWith(" ")) append(" ", null);
        if (previousUnit.hasEOL) {
          if (unit.softLineBreakWithPrevious === true) {
            const dehyphenateStart = lineEndHyphenStart(
              text,
              breakStart,
              next,
            );
            layoutBreaks.push({
              start: breakStart,
              end: breakStart + 1,
              ...(dehyphenateStart === null ? {} : { dehyphenateStart }),
            });
          } else {
            hardBreaks.push({ start: breakStart, end: breakStart + 1 });
          }
        }
      }
    }

    for (let start = 0; start < unit.text.length; ) {
      const whitespace = /\s/.test(unit.text[start] ?? "");
      let end = start + 1;
      while (
        end < unit.text.length &&
        /\s/.test(unit.text[end] ?? "") === whitespace
      ) {
        end += 1;
      }
      if (whitespace) {
        if (text.length > 0 && !text.endsWith(" ")) {
          append(" ", unitIndex, start, end);
        }
      } else {
        append(unit.text.slice(start, end), unitIndex, start, end);
      }
      start = end;
    }
    previousUnit = unit;
  });

  if (text.endsWith(" ")) {
    text = text.slice(0, -1);
    const trailing = spans[spans.length - 1];
    if (trailing?.start === text.length && trailing.end === text.length + 1) {
      spans.pop();
    }
  }

  return { text, spans, layoutBreaks, hardBreaks };
}

/** Map a normalized semantic-text range back to unit-local offsets without a
 * per-character object table. Collapsed whitespace maps to its complete
 * source run; synthetic separators have no span and are intentionally skipped. */
export function semanticRangeToUnitOffsets(
  index: SemanticSearchIndex,
  range: { start: number; end: number },
  options: { consumeWork?: (amount: number) => void } = {},
): Map<number, SemanticUnitOffsetRange> {
  const start = clampSearchOffset(range.start, index.text.length);
  const end = clampSearchOffset(range.end, index.text.length);
  const byUnit = new Map<number, SemanticUnitOffsetRange>();
  if (end <= start) return byUnit;

  for (const span of index.spans) {
    options.consumeWork?.(1);
    if (span.end <= start) continue;
    if (span.start >= end) break;
    const overlapStart = Math.max(start, span.start);
    const overlapEnd = Math.min(end, span.end);
    const searchLength = span.end - span.start;
    const unitLength = span.unitEnd - span.unitStart;
    const exact = searchLength === unitLength;
    const startOffset = exact
      ? span.unitStart + (overlapStart - span.start)
      : span.unitStart;
    const endOffset = exact
      ? span.unitStart + (overlapEnd - span.start)
      : span.unitEnd;
    const current = byUnit.get(span.unitIndex);
    if (!current) {
      byUnit.set(span.unitIndex, { startOffset, endOffset });
    } else {
      current.startOffset = Math.min(current.startOffset, startOffset);
      current.endOffset = Math.max(current.endOffset, endOffset);
    }
  }
  return byUnit;
}

// CJK scripts (Han, kana, Hangul, fullwidth / CJK punctuation) do not separate
// characters with spaces. The search index must not insert one between two such
// characters or substring queries like "中文" stop matching.
function shouldJoinSemanticUnits(previous: string, next: string): boolean {
  if (!previous || !next) return false;
  return (
    (isCjkCodePoint(previous) && isCjkCodePoint(next)) ||
    isGraphemeContinuation(next) ||
    previous === "\u200d" ||
    (isRegionalIndicator(previous) && isRegionalIndicator(next))
  );
}

function shouldJoinSemanticUnitBoundary(
  previousUnit: SemanticTextUnit,
  currentUnit: SemanticTextUnit,
  previousCharacter: string,
  nextCharacter: string,
): boolean {
  if (previousUnit.hasEOL) return false;
  if (currentUnit.joinWithPrevious !== undefined) {
    return currentUnit.joinWithPrevious;
  }
  return shouldJoinSemanticUnits(previousCharacter, nextCharacter);
}

function isCjkCodePoint(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? -1;
  return (
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
      character,
    ) ||
    (codePoint >= 0x3000 && codePoint <= 0x303f) ||
    (codePoint >= 0xff00 && codePoint <= 0xffef)
  );
}

function isGraphemeContinuation(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? -1;
  return (
    /\p{Mark}/u.test(character) ||
    character === "\u200d" ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef) ||
    (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff)
  );
}

export function isSemanticGeometryContinuation(text: string): boolean {
  const characters = Array.from(text);
  return (
    characters.length > 0 &&
    characters.every((character) => isGraphemeContinuation(character))
  );
}

function isRegionalIndicator(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? -1;
  return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
}
function firstVisibleChar(s: string): string {
  const m = s.match(/\S/u);
  return m ? m[0] : "";
}

function lastVisibleCodePoint(s: string): string {
  // Read backwards from the end instead of rescanning the accumulated index
  // for every unit. A per-glyph PDF can contain 100k units, so a forward scan
  // here turns otherwise-linear indexing into quadratic work.
  for (let end = s.length; end > 0; ) {
    let start = end - 1;
    const lastUnit = s.charCodeAt(start);
    if (lastUnit >= 0xdc00 && lastUnit <= 0xdfff && start > 0) {
      const previousUnit = s.charCodeAt(start - 1);
      if (previousUnit >= 0xd800 && previousUnit <= 0xdbff) start -= 1;
    }
    const character = s.slice(start, end);
    if (/\S/u.test(character)) return character;
    end = start;
  }
  return "";
}

function lineEndHyphenStart(
  text: string,
  separatorStart: number,
  nextCharacter: string,
): number | null {
  if (!/^(?:\p{L}|\p{N})$/u.test(nextCharacter)) return null;
  const end = separatorStart;
  if (end <= 0) return null;
  const start = previousCodePointStart(text, end);
  const character = text.slice(start, end);
  return /^[-\u00ad\u2010\u2011]$/u.test(character) ? start : null;
}

function previousCodePointStart(text: string, end: number): number {
  const last = text.charCodeAt(end - 1);
  if (last >= 0xdc00 && last <= 0xdfff && end > 1) {
    const previous = text.charCodeAt(end - 2);
    if (previous >= 0xd800 && previous <= 0xdbff) return end - 2;
  }
  return end - 1;
}

function normalizeSemanticText(text: string, preserveLineBreaks: boolean): string {
  if (preserveLineBreaks) {
    return text
      .replace(/[ \t\f\v]+/g, " ")
      .replace(/ *\n+ */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  return text.replace(/\s+/g, " ").trim();
}

function assertSemanticTextContentWithinLimits(textContent: TextContent): void {
  if (textContent.items.length > MAX_SEMANTIC_CONTENT_ITEMS_PER_PAGE) {
    throw new SemanticTextLimitError(
      `Page text content has ${textContent.items.length} items; the safe limit is ${MAX_SEMANTIC_CONTENT_ITEMS_PER_PAGE}`,
    );
  }
  if (Object.keys(textContent.styles).length > MAX_SEMANTIC_STYLES_PER_PAGE) {
    throw new SemanticTextLimitError(
      `Page text content exceeds ${MAX_SEMANTIC_STYLES_PER_PAGE} styles`,
    );
  }
  if (
    semanticTextContentCost(textContent).sourceCharacters >
    MAX_SEMANTIC_SOURCE_CHARACTERS_PER_PAGE
  ) {
    throw new SemanticTextLimitError(
      `Page text content exceeds ${MAX_SEMANTIC_SOURCE_CHARACTERS_PER_PAGE} characters`,
    );
  }
  let depth = 0;
  for (const item of textContent.items as RuntimeTextContentItem[]) {
    if (isMarkedContentBegin(item)) {
      depth += 1;
      if (depth > MAX_SEMANTIC_MARKED_CONTENT_DEPTH) {
        throw new SemanticTextLimitError(
          `Page marked-content nesting exceeds ${MAX_SEMANTIC_MARKED_CONTENT_DEPTH}`,
        );
      }
    } else if ("type" in item && item.type === "endMarkedContent") {
      if (depth === 0) {
        throw new SemanticTextLimitError(
          "Page text contains unbalanced marked content",
        );
      }
      depth -= 1;
    }
  }
  if (depth !== 0) {
    throw new SemanticTextLimitError(
      "Page text contains unbalanced marked content",
    );
  }
}

function semanticTextItemCharacterCount(item: RuntimeTextContentItem): number {
  const raw = isTextItem(item) ? item.str.length : 0;
  return raw + (maybeActualText(item)?.length ?? 0);
}

function clampSearchOffset(value: number, max: number): number {
  return Math.max(
    0,
    Math.min(Number.isFinite(value) ? Math.trunc(value) : 0, max),
  );
}

function isTextItem(item: RuntimeTextContentItem): item is RuntimeTextItem {
  return typeof (item as Partial<TextItem>).str === "string";
}

function preferredText(item: RuntimeTextItem): string {
  return maybeActualText(item) ?? item.str;
}

function maybeActualText(item: { actualText?: unknown }): string | null {
  return typeof item.actualText === "string" ? item.actualText : null;
}

function isMarkedContentBegin(item: RuntimeTextContentItem): boolean {
  return (
    !isTextItem(item) &&
    (item.type === "beginMarkedContent" ||
      item.type === "beginMarkedContentProps")
  );
}

function textItemsAreVisuallyContiguous(
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
function classifySoftLineContinuationStarts(
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
