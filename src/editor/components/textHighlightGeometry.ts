import type {
  ContentTextOverlay,
  HighlightOverlay,
  PageModel,
  StrikeOutOverlay,
  UnderlineOverlay,
} from "../../pdf/model/types";
import { displayToPdf } from "../../pdf/geometry/coords";
import {
  type DisplayRect,
  type RectLike,
  type TextRunDisplayBounds,
  type TextOffsetSide,
  clientRectsToDisplayRects,
  normalizeDomTextOffsetX,
  textOffsetForX,
} from "../textSelection/highlightRects";
import {
  type SemanticTextLayerModel,
  type SemanticTextUnit,
  semanticClipboardTextForUnits,
  semanticRangeToUnitOffsets,
  semanticUnitsToSearchIndex,
} from "../textSelection/semanticText";
import type { AnnotationDefaults, Store } from "../store/store";

type Point = { x: number; y: number };
type TextGesture = { start: Point; startedOnText: boolean; clickCount: number };
type SemanticCopyLayerModel = SemanticTextLayerModel & {
  textDivs: HTMLElement[];
};

type TextRunGeometryLayerModel = {
  textDivs: HTMLElement[];
  textRuns: Array<TextRunDisplayBounds | null>;
};
type SelectedTextRun = {
  run: TextRunDisplayBounds;
  text: string;
  startOffset: number;
  endOffset: number;
  offsetXs: number[];
  selectionSource?: "nativeRange" | "gesture";
};
type TextMarkupType =
  | HighlightOverlay["type"]
  | UnderlineOverlay["type"]
  | StrikeOutOverlay["type"];
type TextDefaults = Store["textDefaults"];

const CONTENT_TEXT_EDIT_RIGHT_PAD_PT = 2.2;
const DASH_PREFIX_INK_PAD_RATIO = 0.14;
const DASH_PREFIX_INK_PAD_MIN_PX = 1.25;
const DASH_PREFIX_INK_PAD_MAX_PX = 2.4;

function textBoxDisplayRect(start: Point, end: Point): DisplayRect {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const w = Math.abs(end.x - start.x);
  const h = Math.abs(end.y - start.y);
  if (w < 8 || h < 8) {
    return { x: start.x, y: start.y, w: 180, h: 42 };
  }
  return { x, y, w, h };
}

function textMarkupDefaults(
  type: TextMarkupType,
  defaults: AnnotationDefaults,
): { color: string; opacity: number } {
  if (type === "strikethrough") {
    return {
      color: defaults.strikethroughColor,
      opacity: defaults.strikethroughOpacity,
    };
  }
  if (type === "underline") {
    return {
      color: defaults.underlineColor,
      opacity: defaults.underlineOpacity,
    };
  }
  return {
    color: defaults.highlightColor,
    opacity: defaults.highlightOpacity,
  };
}

function selectedTextRunsForRange(
  range: Range,
  geometry: TextRunGeometryLayerModel | null,
  rootRect: DOMRect,
  pageWidthPx: number,
  pageHeightPx: number,
  pageWidthPt: number,
): SelectedTextRun[] {
  if (!geometry) return [];
  const selectedRuns: SelectedTextRun[] = [];
  for (let i = 0; i < geometry.textDivs.length; i += 1) {
    const textDiv = geometry.textDivs[i];
    if (!textDiv) continue;
    if (rangeIntersectsNode(range, textDiv)) {
      const textRun =
        geometry.textRuns[i] ??
        textDivDisplayRun(textDiv, rootRect, pageWidthPx, pageHeightPx);
      if (!textRun) continue;
      const computed = window.getComputedStyle(textDiv);
      const run = {
        ...textRun,
        cssFontFamily: computed.fontFamily,
        cssFontWeight: computed.fontWeight,
        cssFontStyle: computed.fontStyle,
        cssFontSizePt: cssPxToPt(computed.fontSize, pageWidthPx, pageWidthPt),
      };
      selectedRuns.push({
        run,
        ...selectedTextInElement(range, textDiv),
        selectionSource: "nativeRange",
        offsetXs: textRunOffsetXs(textDiv, run, rootRect, pageWidthPx, pageHeightPx),
      });
    }
  }
  return selectedRuns;
}

function selectedTextRunsForDisplayRects(
  rects: DisplayRect[],
  geometry: TextRunGeometryLayerModel | null,
  rootRect: DOMRect,
  pageWidthPx: number,
  pageHeightPx: number,
  pageWidthPt: number,
): SelectedTextRun[] {
  if (!geometry || rects.length === 0) return [];
  const selectedRuns: SelectedTextRun[] = [];
  for (let i = 0; i < geometry.textDivs.length; i += 1) {
    const textDiv = geometry.textDivs[i];
    if (!textDiv) continue;
    const textRun =
      geometry.textRuns[i] ??
      textDivDisplayRun(textDiv, rootRect, pageWidthPx, pageHeightPx);
    if (!textRun || !rects.some((rect) => displayRectsOverlap(rect, textRun))) {
      continue;
    }
    const computed = window.getComputedStyle(textDiv);
    const run = {
      ...textRun,
      cssFontFamily: computed.fontFamily,
      cssFontWeight: computed.fontWeight,
      cssFontStyle: computed.fontStyle,
      cssFontSizePt: cssPxToPt(computed.fontSize, pageWidthPx, pageWidthPt),
    };
    selectedRuns.push({
      run,
      text: run.text,
      startOffset: 0,
      endOffset: run.text.length,
      selectionSource: "gesture",
      offsetXs: textRunOffsetXs(textDiv, run, rootRect, pageWidthPx, pageHeightPx),
    });
  }
  return selectedRuns;
}

function textDivDisplayRun(
  textDiv: HTMLElement,
  rootRect: DOMRect,
  pageWidthPx: number,
  pageHeightPx: number,
): TextRunDisplayBounds | null {
  const rect = clientRectsToDisplayRects(
    [textDiv.getBoundingClientRect()],
    rootRect,
    pageWidthPx,
    pageHeightPx,
  )[0];
  if (!rect) return null;
  return {
    ...rect,
    text: textDiv.textContent ?? "",
  };
}

// Per-character x offsets within a text run are static for a given rendered
// text layer: they depend only on the glyph layout, which is fixed until the
// layer re-renders at a new scale (at which point these text divs are replaced
// with fresh ones). Drag-selection, however, asks for them on every
// pointer-move frame, for every run under the selection — and computing them
// walks the run character-by-character with getBoundingClientRect. Cache the
// result per text div so a drag pays that walk once per run per render instead
// of once per frame. Keyed by the div element via a WeakMap, the cache clears
// itself when the layer rebuilds and the old divs are garbage-collected.
const runOffsetXsCache = new WeakMap<HTMLElement, number[]>();

function textRunOffsetXs(
  textDiv: HTMLElement,
  run: TextRunDisplayBounds,
  rootRect: DOMRect,
  pageWidthPx: number,
  pageHeightPx: number,
): number[] {
  const cached = runOffsetXsCache.get(textDiv);
  if (cached) return cached;
  const computed = computeRunOffsetXs(
    textDiv,
    run,
    rootRect,
    pageWidthPx,
    pageHeightPx,
  );
  runOffsetXsCache.set(textDiv, computed);
  return computed;
}

function computeRunOffsetXs(
  textDiv: HTMLElement,
  run: TextRunDisplayBounds,
  rootRect: DOMRect,
  pageWidthPx: number,
  pageHeightPx: number,
): number[] {
  const textLength = run.text.length;
  if (textLength === 0) return [run.x];
  const fallback = uniformRunOffsetXs(run);
  const textNode = firstTextNode(textDiv);
  if (!textNode || textNode.length < textLength) return fallback;

  const offsets = [...fallback];
  const range = document.createRange();
  try {
    range.setStart(textNode, 0);
    range.setEnd(textNode, textLength);
    const fullRect = clientRectsToDisplayRects(
      [range.getBoundingClientRect()],
      rootRect,
      pageWidthPx,
      pageHeightPx,
    )[0];
    if (!fullRect) return fallback;
    const domStartX = fullRect.x;
    const domEndX = fullRect.x + fullRect.w;
    for (let i = 1; i < textLength; i += 1) {
      range.setStart(textNode, 0);
      range.setEnd(textNode, i);
      const rect = clientRectsToDisplayRects(
        [range.getBoundingClientRect()],
        rootRect,
        pageWidthPx,
        pageHeightPx,
      )[0];
      if (rect) {
        offsets[i] = normalizeDomTextOffsetX(
          run,
          domStartX,
          domEndX,
          rect.x + rect.w,
        );
      }
    }
  } catch {
    return fallback;
  } finally {
    range.detach();
  }
  return monotonicOffsetXs(offsets);
}

function uniformRunOffsetXs(run: TextRunDisplayBounds): number[] {
  const textLength = run.text.length;
  const offsets: number[] = [];
  for (let i = 0; i <= textLength; i += 1) {
    offsets.push(run.x + (run.w * i) / Math.max(1, textLength));
  }
  return offsets;
}

function monotonicOffsetXs(offsets: number[]): number[] {
  const out = [...offsets];
  for (let i = 1; i < out.length; i += 1) {
    out[i] = Math.max(out[i]!, out[i - 1]!);
  }
  return out;
}

function searchHighlightDisplayRects(
  charStart: number,
  charEnd: number,
  semanticLayer: SemanticCopyLayerModel,
  rootRect: DOMRect,
  pageWidthPx: number,
  pageHeightPx: number,
): DisplayRect[] {
  const ranges = searchHighlightRanges(charStart, charEnd, semanticLayer);
  const clientRects = ranges.flatMap((range) => Array.from(range.getClientRects()));
  return clientRectsToDisplayRects(clientRects, rootRect, pageWidthPx, pageHeightPx);
}

function searchHighlightRanges(
  charStart: number,
  charEnd: number,
  semanticLayer: SemanticCopyLayerModel,
): Range[] {
  const searchIndex = semanticUnitsToSearchIndex(semanticLayer.units);
  const byUnit = semanticRangeToUnitOffsets(searchIndex, {
    start: charStart,
    end: charEnd,
  });

  return Array.from(byUnit.entries()).flatMap(([unitIndex, offsets]) => {
    const unit = semanticLayer.units[unitIndex];
    if (!unit) return [];
    const range = rangeForSemanticUnit(unit, offsets, semanticLayer.textDivs);
    return range ? [range] : [];
  });
}

function rangeForSemanticUnit(
  unit: SemanticTextUnit,
  offsets: { startOffset: number; endOffset: number },
  textDivs: HTMLElement[],
): Range | null {
  if (unit.kind === "actualText") {
    return rangeAcrossDivs(textDivs[unit.startDivIndex], textDivs[unit.endDivIndex]);
  }

  const div = textDivs[unit.divIndex];
  if (!div) return null;
  if (unit.text !== unit.rawText) return rangeAcrossDivs(div, div);
  const textNode = firstTextNode(div);
  if (!textNode) return rangeAcrossDivs(div, div);
  const start = clampIndex(offsets.startOffset, textNode.length);
  const end = clampIndex(offsets.endOffset, textNode.length);
  if (start >= end) return null;
  const range = document.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, end);
  return range;
}

function rangeAcrossDivs(
  first: HTMLElement | undefined,
  last: HTMLElement | undefined,
): Range | null {
  if (!first || !last) return null;
  const range = document.createRange();
  range.setStartBefore(first);
  range.setEndAfter(last);
  return range;
}

function firstTextNode(el: HTMLElement): Text | null {
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) return child as Text;
  }
  return null;
}

function clampIndex(n: number, max: number): number {
  return Math.max(0, Math.min(max, n));
}

function hasActiveTextSelection(root: HTMLDivElement | null): boolean {
  if (!root) return false;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return false;
  }
  for (let i = 0; i < selection.rangeCount; i += 1) {
    if (rangeIntersectsNode(selection.getRangeAt(i), root)) return true;
  }
  return false;
}

function isPurePdfTextSelection(
  selection: Selection,
  root: HTMLDivElement,
): boolean {
  if (!root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) {
    return false;
  }
  for (let i = 0; i < selection.rangeCount; i += 1) {
    const range = selection.getRangeAt(i);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
      return false;
    }
  }
  return true;
}

function buildSemanticClipboardText(
  selection: Selection,
  semanticLayer: SemanticCopyLayerModel,
): string | null {
  const selectedUnits = semanticLayer.units.filter((unit) =>
    selectionIntersectsUnit(selection, unit, semanticLayer.textDivs),
  );
  if (selectedUnits.length === 0) return null;
  return semanticClipboardTextForUnits(selectedUnits);
}

function selectionIntersectsUnit(
  selection: Selection,
  unit: SemanticTextUnit,
  textDivs: HTMLElement[],
): boolean {
  if (unit.kind === "text") {
    return selectionIntersectsDiv(selection, textDivs[unit.divIndex]);
  }
  for (let i = unit.startDivIndex; i <= unit.endDivIndex; i += 1) {
    if (selectionIntersectsDiv(selection, textDivs[i])) return true;
  }
  return false;
}

function selectionIntersectsDiv(
  selection: Selection,
  div: HTMLElement | undefined,
): boolean {
  if (!div) return false;
  for (let i = 0; i < selection.rangeCount; i += 1) {
    if (rangeIntersectsNode(selection.getRangeAt(i), div)) return true;
  }
  return false;
}

function isBlankTextClick(gesture: TextGesture | null, end: Point): boolean {
  if (!gesture || gesture.startedOnText) return false;
  return textGestureDistance(gesture, end) < 4;
}

function isSpuriousFullLayerSelection(
  gesture: TextGesture | null,
  end: Point,
  rootRect: DOMRect,
  rects: DisplayRect[],
): boolean {
  if (!gesture || textGestureDistance(gesture, end) >= 4) return false;
  if (gesture.clickCount >= 4) return true;

  const rootArea = rootRect.width * rootRect.height;
  if (rootArea <= 0) return false;
  const selectionArea = rects.reduce((sum, rect) => sum + rect.w * rect.h, 0);
  return selectionArea / rootArea > 0.85;
}

function textGestureDistance(gesture: TextGesture, end: Point): number {
  const dx = end.x - gesture.start.x;
  const dy = end.y - gesture.start.y;
  return Math.hypot(dx, dy);
}

function isPdfTextTarget(
  target: EventTarget | null,
  root: HTMLDivElement | null,
): boolean {
  if (!(target instanceof Element) || !root?.contains(target)) return false;
  const textNode = target.closest("span, br");
  return textNode !== null && root.contains(textNode);
}

function safeCompare(range: Range, how: number, sourceRange: Range): number | null {
  try {
    return range.compareBoundaryPoints(how, sourceRange);
  } catch {
    return null;
  }
}

function rangeIntersectsNode(range: Range, node: Node): boolean {
  try {
    return range.intersectsNode(node);
  } catch {
    return false;
  }
}

function selectedTextFromSelection(selection: Selection): string {
  return selection
    .toString()
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .trim();
}

function summarizeGesture(gesture: TextGesture | null, end: Point) {
  if (!gesture) {
    return {
      present: false,
      end: summarizePoint(end),
    };
  }
  return {
    present: true,
    start: summarizePoint(gesture.start),
    end: summarizePoint(end),
    distance: roundDebug(textGestureDistance(gesture, end)),
    startedOnText: gesture.startedOnText,
    clickCount: gesture.clickCount,
  };
}

function summarizeSelectedTextRun(entry: SelectedTextRun) {
  const aroundStart = Math.max(0, entry.startOffset - 4);
  const aroundEnd = Math.min(entry.offsetXs.length, entry.endOffset + 5);
  return {
    text: entry.text,
    startOffset: entry.startOffset,
    endOffset: entry.endOffset,
    selectionSource: entry.selectionSource,
    run: summarizeTextRun(entry.run),
    selectedXRange: {
      start: roundDebug(runXForOffset(entry, entry.startOffset)),
      end: roundDebug(runXForOffset(entry, entry.endOffset)),
    },
    offsetXsLength: entry.offsetXs.length,
    offsetXsAroundSelection: entry.offsetXs
      .slice(aroundStart, aroundEnd)
      .map(roundDebug),
  };
}

function summarizeTextRun(run: TextRunDisplayBounds) {
  return {
    text: run.text,
    rect: summarizeDisplayRect(run),
    fontName: run.fontName,
    fontFamily: run.fontFamily,
    fontSizePt: roundOptional(run.fontSizePt),
    cssFontFamily: run.cssFontFamily,
    cssFontWeight: run.cssFontWeight,
    cssFontStyle: run.cssFontStyle,
    cssFontSizePt: roundOptional(run.cssFontSizePt),
  };
}

function summarizeContentTextOverlay(overlay: ContentTextOverlay) {
  return {
    id: overlay.id,
    pageId: overlay.pageId,
    originalText: overlay.originalText,
    text: overlay.text,
    rect: summarizePdfRect(overlay.rect),
    coverRects: overlay.coverRects.map(summarizePdfRect),
    fontSize: overlay.fontSize,
    color: overlay.color,
    bold: overlay.bold,
    italic: overlay.italic,
    align: overlay.align,
    fontFamily: overlay.fontFamily,
    renderedFont: overlay.renderedFont,
    backgroundColor: overlay.backgroundColor,
    sourceBaselinesPt: overlay.sourceBaselinesPt?.map(roundDebug),
  };
}

function summarizeDisplayRect(rect: DisplayRect) {
  return {
    x: roundDebug(rect.x),
    y: roundDebug(rect.y),
    w: roundDebug(rect.w),
    h: roundDebug(rect.h),
  };
}

function summarizePdfRect(rect: ContentTextOverlay["rect"]) {
  return {
    x: roundDebug(rect.x),
    y: roundDebug(rect.y),
    w: roundDebug(rect.w),
    h: roundDebug(rect.h),
  };
}

function summarizeClientRect(rect: RectLike) {
  return {
    left: roundDebug(rect.left),
    top: roundDebug(rect.top),
    right: roundDebug(rect.right),
    bottom: roundDebug(rect.bottom),
  };
}

function summarizePoint(point: Point) {
  return {
    x: roundDebug(point.x),
    y: roundDebug(point.y),
  };
}

function roundOptional(value: number | undefined): number | undefined {
  return typeof value === "number" ? roundDebug(value) : undefined;
}

function roundDebug(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function selectedTextInElement(
  range: Range,
  element: HTMLElement,
): Pick<SelectedTextRun, "text" | "startOffset" | "endOffset"> {
  const text = element.textContent ?? "";
  if (!text) return { text: "", startOffset: 0, endOffset: 0 };
  const elementRange = document.createRange();
  elementRange.selectNodeContents(element);
  const rangeEndsBeforeElement =
    safeCompare(range, Range.END_TO_START, elementRange) !== null &&
    safeCompare(range, Range.END_TO_START, elementRange)! <= 0;
  const rangeStartsAfterElement =
    safeCompare(range, Range.START_TO_END, elementRange) !== null &&
    safeCompare(range, Range.START_TO_END, elementRange)! >= 0;
  if (rangeEndsBeforeElement || rangeStartsAfterElement) {
    return { text: "", startOffset: 0, endOffset: 0 };
  }
  let start = 0;
  let end = text.length;
  if (element.contains(range.startContainer)) {
    start = textOffsetWithin(element, range.startContainer, range.startOffset);
  }
  if (element.contains(range.endContainer)) {
    end = textOffsetWithin(element, range.endContainer, range.endOffset);
  }
  const startOffset = clampIndex(start, text.length);
  const endOffset = clampIndex(end, text.length);
  return {
    text: text.slice(startOffset, endOffset),
    startOffset,
    endOffset,
  };
}

function textOffsetWithin(
  root: HTMLElement,
  container: Node,
  offset: number,
): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let total = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    if (node === container) return total + offset;
    total += text.length;
  }
  return offset <= 0 ? 0 : total;
}

function filterSelectedRunTexts(
  entries: SelectedTextRun[],
  rects: DisplayRect[],
): SelectedTextRun[] {
  if (entries.length === 0 || rects.length === 0) return [];
  return entries.filter(
    (entry) =>
      entry.startOffset < entry.endOffset &&
      rects.some((rect) => displayRectsOverlap(rect, entry.run)),
  );
}

function trimSelectedRunTextsToGesture(
  entries: SelectedTextRun[],
  gesture: TextGesture | null,
  end: Point,
): SelectedTextRun[] {
  if (!gesture || entries.length === 0 || textGestureDistance(gesture, end) < 4) {
    return entries;
  }
  const first = entries[0]!;
  const last = entries[entries.length - 1]!;
  const forward = gestureRunsForward(entries, gesture.start, end);
  const startPoint = forward ? gesture.start : end;
  const endPoint = forward ? end : gesture.start;

  const trimmed = entries
    .map((entry) => {
      let startOffset = entry.startOffset;
      let endOffset = entry.endOffset;
      if (sameTextLine(entry.run, first.run)) {
        startOffset = Math.max(
          startOffset,
          offsetForRunX(entry, startPoint.x, "start"),
        );
      }
      if (sameTextLine(entry.run, last.run)) {
        endOffset = Math.min(
          endOffset,
          offsetForRunX(entry, endPoint.x, "end"),
        );
      }
      startOffset = clampIndex(startOffset, entry.run.text.length);
      endOffset = clampIndex(endOffset, entry.run.text.length);
      return {
        ...entry,
        startOffset,
        endOffset,
        text: entry.run.text.slice(startOffset, endOffset),
      };
    })
    .filter((entry) => entry.startOffset < entry.endOffset && entry.text !== "");
  if (trimmed.some((entry) => entry.selectionSource === "gesture")) {
    return trimTrailingWordHeadToGesture(
      trimTrailingPunctuationToGesture(
        trimLeadingPunctuationToGesture(
          trimLeadingHyphenatedPrefixToGesture(
            trimLeadingWordTailToGesture(trimmed, startPoint),
            startPoint,
          ),
          startPoint,
        ),
        endPoint,
      ),
      endPoint,
    );
  }
  const wordSnapped = snapSelectedRunTextsToWordBoundaries(trimmed);
  return trimTrailingWordHeadToGesture(
    trimTrailingPunctuationToGesture(
      trimLeadingPunctuationToGesture(
        trimLeadingHyphenatedPrefixToGesture(
          trimLeadingWordTailToGesture(wordSnapped, startPoint),
          startPoint,
        ),
        startPoint,
      ),
      endPoint,
    ),
    endPoint,
  );
}

function snapSelectedRunTextsToWordBoundaries(
  entries: SelectedTextRun[],
): SelectedTextRun[] {
  if (entries.length === 0) return entries;
  return entries
    .map((entry, index) => {
      let startOffset = entry.startOffset;
      let endOffset = entry.endOffset;
      if (index === 0) {
        startOffset = wordStartOffset(entry.run.text, startOffset);
      }
      if (index === entries.length - 1) {
        endOffset = wordEndOffset(entry.run.text, endOffset);
      }
      return {
        ...entry,
        startOffset,
        endOffset,
        text: entry.run.text.slice(startOffset, endOffset),
      };
    })
    .filter((entry) => entry.startOffset < entry.endOffset && entry.text !== "");
}

function wordStartOffset(text: string, offset: number): number {
  let i = clampIndex(offset, text.length);
  if (i <= 0 || i >= text.length) return i;
  if (!isWordChar(text[i - 1]!) || !isWordChar(text[i]!)) return i;
  while (i > 0 && isWordChar(text[i - 1]!)) i -= 1;
  return i;
}

function wordEndOffset(text: string, offset: number): number {
  let i = clampIndex(offset, text.length);
  if (i <= 0 || i >= text.length) return i;
  if (!isWordChar(text[i - 1]!) || !isWordChar(text[i]!)) return i;
  while (i < text.length && isWordChar(text[i]!)) i += 1;
  return i;
}

function isWordChar(ch: string): boolean {
  return /[\p{L}\p{N}_]/u.test(ch);
}

function trimLeadingWordTailToGesture(
  entries: SelectedTextRun[],
  startPoint: Point,
): SelectedTextRun[] {
  const first = entries[0];
  if (!first) return entries;
  const prefix = /^\S+\s+/u.exec(first.text.replace(/\u00a0/g, " "));
  if (!prefix) return entries;
  const prefixEndOffset = first.startOffset + prefix[0].length;
  const prefixLeft = runXForOffset(first, first.startOffset);
  const prefixRight = runXForOffset(first, prefixEndOffset);
  const prefixMid = prefixLeft + (prefixRight - prefixLeft) * 0.5;
  const tolerance = Math.max(1, first.run.h * 0.08);
  if (startPoint.x < prefixMid - tolerance) return entries;
  const trimmedFirst: SelectedTextRun = {
    ...first,
    startOffset: clampIndex(prefixEndOffset, first.run.text.length),
    text: first.run.text.slice(prefixEndOffset, first.endOffset),
  };
  return [trimmedFirst, ...entries.slice(1)].filter(
    (entry) => entry.startOffset < entry.endOffset && entry.text !== "",
  );
}

function trimLeadingPunctuationToGesture(
  entries: SelectedTextRun[],
  startPoint: Point,
): SelectedTextRun[] {
  const first = entries[0];
  if (!first) return entries;
  const normalized = first.text.replace(/\u00a0/g, " ");
  const leading = /^[^\p{L}\p{N}_]+(?=[\p{L}\p{N}_])/u.exec(normalized);
  if (!leading) return entries;
  const punctuationEndOffset = first.startOffset + leading[0].length;
  const punctuationLeft = runXForOffset(first, first.startOffset);
  const punctuationRight = runXForOffset(first, punctuationEndOffset);
  const punctuationWidth = punctuationRight - punctuationLeft;
  const tolerance = Math.max(
    1,
    Math.min(first.run.h * 0.08, punctuationWidth * 0.25),
  );
  if (startPoint.x < punctuationRight - tolerance) return entries;
  const trimmedFirst: SelectedTextRun = {
    ...first,
    startOffset: clampIndex(punctuationEndOffset, first.run.text.length),
    text: first.run.text.slice(punctuationEndOffset, first.endOffset),
  };
  return [trimmedFirst, ...entries.slice(1)].filter(
    (entry) => entry.startOffset < entry.endOffset && entry.text !== "",
  );
}

function trimLeadingHyphenatedPrefixToGesture(
  entries: SelectedTextRun[],
  startPoint: Point,
): SelectedTextRun[] {
  const first = entries[0];
  if (!first) return entries;
  const normalized = first.text.replace(/\u00a0/g, " ");
  const prefix =
    /^[\p{L}\p{N}_]+(?:['’][\p{L}\p{N}_]+)*[-‐‑‒–—]+(?=[\p{L}\p{N}_])/u.exec(
      normalized,
    );
  if (!prefix) return entries;
  const prefixEndOffset = first.startOffset + prefix[0].length;
  const prefixLeft = runXForOffset(first, first.startOffset);
  const prefixRight = runXForOffset(first, prefixEndOffset);
  const prefixMid = prefixLeft + (prefixRight - prefixLeft) * 0.5;
  const tolerance = Math.max(1, first.run.h * 0.08);
  if (startPoint.x < prefixMid - tolerance) return entries;
  const trimmedFirst: SelectedTextRun = {
    ...first,
    startOffset: clampIndex(prefixEndOffset, first.run.text.length),
    text: first.run.text.slice(prefixEndOffset, first.endOffset),
  };
  return [trimmedFirst, ...entries.slice(1)].filter(
    (entry) => entry.startOffset < entry.endOffset && entry.text !== "",
  );
}

function trimTrailingPunctuationToGesture(
  entries: SelectedTextRun[],
  endPoint: Point,
): SelectedTextRun[] {
  const last = entries[entries.length - 1];
  if (!last) return entries;
  const normalized = last.text.replace(/\u00a0/g, " ");
  const trailing = /(?<=[\p{L}\p{N}_])[-‐‑‒–—,.;:!?，。！？；：、]+$/u.exec(
    normalized,
  );
  if (!trailing) return entries;
  const punctuationStartOffset = last.endOffset - trailing[0].length;
  const punctuationLeft = runXForOffset(last, punctuationStartOffset);
  const punctuationRight = runXForOffset(last, last.endOffset);
  const punctuationWidth = punctuationRight - punctuationLeft;
  const tolerance = Math.max(
    1,
    Math.min(last.run.h * 0.08, punctuationWidth * 0.35),
  );
  if (endPoint.x > punctuationRight + tolerance) return entries;
  const trimmedLast: SelectedTextRun = {
    ...last,
    endOffset: clampIndex(punctuationStartOffset, last.run.text.length),
    text: last.run.text.slice(last.startOffset, punctuationStartOffset),
  };
  return [...entries.slice(0, -1), trimmedLast].filter(
    (entry) => entry.startOffset < entry.endOffset && entry.text !== "",
  );
}

function trimTrailingWordHeadToGesture(
  entries: SelectedTextRun[],
  endPoint: Point,
): SelectedTextRun[] {
  const last = entries[entries.length - 1];
  if (!last) return entries;
  const suffix = /\s+\S+$/u.exec(last.text.replace(/\u00a0/g, " "));
  if (suffix) {
    const suffixStartOffset = last.endOffset - suffix[0].length;
    const suffixLeft = runXForOffset(last, suffixStartOffset);
    const suffixRight = runXForOffset(last, last.endOffset);
    if (!shouldTrimWordHead(suffixLeft, suffixRight, last.run.h, endPoint.x)) {
      return entries;
    }
    const trimmedLast: SelectedTextRun = {
      ...last,
      endOffset: clampIndex(suffixStartOffset, last.run.text.length),
      text: last.run.text.slice(last.startOffset, suffixStartOffset),
    };
    return [...entries.slice(0, -1), trimmedLast].filter(
      (entry) => entry.startOffset < entry.endOffset && entry.text !== "",
    );
  }

  const previous = entries[entries.length - 2];
  const normalizedLast = last.text.replace(/\u00a0/g, " ");
  const normalizedPrevious = previous?.text.replace(/\u00a0/g, " ") ?? "";
  const hasInterRunSpace =
    /\s$/u.test(normalizedPrevious) ||
    (previous
      ? needsInterRunSpace(previous, last, normalizedPrevious)
      : false);
  if (
    !previous ||
    !/^\S+$/u.test(normalizedLast) ||
    !containsWordChar(normalizedLast) ||
    !sameTextLine(previous.run, last.run) ||
    !hasInterRunSpace
  ) {
    return entries;
  }
  const wordLeft = runXForOffset(last, last.startOffset);
  const wordRight = runXForOffset(last, last.endOffset);
  if (!shouldTrimWordHead(wordLeft, wordRight, last.run.h, endPoint.x)) {
    return entries;
  }
  return entries.slice(0, -1);
}

function shouldTrimWordHead(
  wordLeft: number,
  wordRight: number,
  lineHeight: number,
  endX: number,
): boolean {
  const wordMid = wordLeft + (wordRight - wordLeft) * 0.5;
  const tolerance = Math.max(1, lineHeight * 0.08);
  return endX <= wordMid + tolerance;
}

function containsWordChar(text: string): boolean {
  return Array.from(text).some(isWordChar);
}

type CoverEdgeSafety = { left: boolean; right: boolean };

function displayRectsFromSelectedRunTexts(entries: SelectedTextRun[]): DisplayRect[] {
  return selectedRunRectsWithEdges(entries).rects;
}

// Per-rect cover geometry PLUS whether each horizontal edge is safe to pad
// generously. An edge that cuts between two glyphs of the same word (the
// neighbouring character is not whitespace) must stay tight: the cover pad
// would otherwise paint over the neighbour's ink. Run-boundary edges are
// treated as safe — pdf.js can split runs mid-word, but the neighbouring
// glyph's cell then belongs to another run we cannot see from here, and
// run edges were already padded before this distinction existed.
function selectedRunRectsWithEdges(entries: SelectedTextRun[]): {
  rects: DisplayRect[];
  edges: CoverEdgeSafety[];
} {
  const items: Array<{ rect: DisplayRect; edge: CoverEdgeSafety }> = [];
  for (const entry of entries) {
    if (entry.startOffset >= entry.endOffset) continue;
    const left = runXForOffset(entry, entry.startOffset);
    const right = runXForOffset(entry, entry.endOffset);
    const visualPadLeft = dashPrefixInkPad(entry);
    const x = Math.max(0, Math.min(left, right) - visualPadLeft);
    const w = Math.abs(right - left) + visualPadLeft;
    if (w < 0.5 || entry.run.h < 0.5) continue;
    const text = entry.run.text;
    const before = entry.startOffset > 0 ? text[entry.startOffset - 1] : undefined;
    const after = entry.endOffset < text.length ? text[entry.endOffset] : undefined;
    items.push({
      rect: { x, y: entry.run.y, w, h: entry.run.h },
      edge: {
        left: before === undefined || /\s/.test(before),
        right: after === undefined || /\s/.test(after),
      },
    });
  }
  return mergeSelectedRunRectItems(items);
}

function dashPrefixInkPad(entry: SelectedTextRun): number {
  if (entry.startOffset <= 0 || entry.startOffset >= entry.run.text.length) {
    return 0;
  }
  const previous = entry.run.text[entry.startOffset - 1];
  const current = entry.run.text[entry.startOffset];
  if (!previous || !current || !isDashChar(previous) || !isWordChar(current)) {
    return 0;
  }
  return Math.max(
    DASH_PREFIX_INK_PAD_MIN_PX,
    Math.min(DASH_PREFIX_INK_PAD_MAX_PX, entry.run.h * DASH_PREFIX_INK_PAD_RATIO),
  );
}

function isDashChar(ch: string): boolean {
  return /[-‐‑‒–—]/u.test(ch);
}

function mergeSelectedRunRectItems(
  items: Array<{ rect: DisplayRect; edge: CoverEdgeSafety }>,
): { rects: DisplayRect[]; edges: CoverEdgeSafety[] } {
  const sorted = [...items].sort((a, b) => {
    if (sameTextLine(a.rect, b.rect)) return a.rect.x - b.rect.x;
    return a.rect.y - b.rect.y;
  });
  const merged: Array<{ rect: DisplayRect; edge: CoverEdgeSafety }> = [];
  for (const item of sorted) {
    const previous = merged[merged.length - 1];
    const rect = item.rect;
    if (
      previous &&
      sameTextLine(previous.rect, rect) &&
      rect.x - (previous.rect.x + previous.rect.w) <=
        Math.max(1, previous.rect.h * 0.12)
    ) {
      const right = Math.max(previous.rect.x + previous.rect.w, rect.x + rect.w);
      const bottom = Math.max(previous.rect.y + previous.rect.h, rect.y + rect.h);
      previous.rect.y = Math.min(previous.rect.y, rect.y);
      previous.rect.h = bottom - previous.rect.y;
      previous.rect.w = right - previous.rect.x;
      // The merged rect's right boundary is the rightmost piece's boundary.
      previous.edge.right = item.edge.right;
    } else {
      merged.push({ rect: { ...rect }, edge: { ...item.edge } });
    }
  }
  return {
    rects: merged.map((item) => item.rect),
    edges: merged.map((item) => item.edge),
  };
}

function gestureRunsForward(
  entries: SelectedTextRun[],
  start: Point,
  end: Point,
): boolean {
  const lines = selectedRunLineGroups(entries);
  if (lines.length === 0) return end.x >= start.x;
  const startLine = closestLineIndex(lines, start.y);
  const endLine = closestLineIndex(lines, end.y);
  if (startLine === endLine) return end.x >= start.x;
  return endLine > startLine;
}

function selectedRunLineGroups(entries: SelectedTextRun[]): TextRunDisplayBounds[][] {
  const lines: TextRunDisplayBounds[][] = [];
  for (const entry of entries) {
    const current = lines[lines.length - 1];
    if (current && sameTextLine(current[0]!, entry.run)) {
      current.push(entry.run);
    } else {
      lines.push([entry.run]);
    }
  }
  return lines;
}

function closestLineIndex(lines: TextRunDisplayBounds[][], y: number): number {
  let bestIndex = 0;
  let bestDistance = Infinity;
  lines.forEach((line, index) => {
    const top = Math.min(...line.map((run) => run.y));
    const bottom = Math.max(...line.map((run) => run.y + run.h));
    const distance = y < top ? top - y : y > bottom ? y - bottom : 0;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function selectedTextFromRunTexts(entries: SelectedTextRun[]): string {
  const out: string[] = [];
  let previous: SelectedTextRun | null = null;
  for (const entry of entries) {
    const text = entry.text.replace(/\u00a0/g, " ");
    if (!text) continue;
    if (previous) {
      if (!sameTextLine(previous.run, entry.run)) {
        out.push("\n");
      } else if (needsInterRunSpace(previous, entry, out[out.length - 1] ?? "")) {
        out.push(" ");
      }
    }
    out.push(text);
    previous = entry;
  }
  return out
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .trim();
}

function displayRectsOverlap(a: DisplayRect, b: DisplayRect): boolean {
  const xOverlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const yOverlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return xOverlap > 0.5 && yOverlap > 0.5;
}

// Genuine overlap in PDF user space — 0.5pt of required penetration so the
// 0.8pt cover-rect padding of ADJACENT lines/words does not read as overlap.
function pdfRectsOverlap(
  a: ContentTextOverlay["coverRects"][number],
  b: ContentTextOverlay["coverRects"][number],
): boolean {
  const xOverlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const yOverlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return xOverlap > 0.5 && yOverlap > 0.5;
}

function sameTextLine(a: DisplayRect, b: DisplayRect): boolean {
  const ac = a.y + a.h / 2;
  const bc = b.y + b.h / 2;
  return Math.abs(ac - bc) <= Math.max(a.h, b.h) * 0.55;
}

function offsetForRunX(
  entry: SelectedTextRun,
  x: number,
  side: TextOffsetSide,
): number {
  const run = entry.run;
  const textLength = run.text.length;
  if (textLength === 0 || run.w <= 0) return 0;
  if (entry.offsetXs.length === textLength + 1) {
    return textOffsetForX(entry.offsetXs, x, side);
  }
  const raw = ((x - run.x) / run.w) * textLength;
  const offset = side === "start" ? Math.floor(raw) : Math.ceil(raw);
  return clampIndex(offset, textLength);
}

function runXForOffset(entry: SelectedTextRun, offset: number): number {
  const clamped = clampIndex(offset, entry.run.text.length);
  if (entry.offsetXs.length === entry.run.text.length + 1) {
    return entry.offsetXs[clamped] ?? entry.run.x;
  }
  const ratio = entry.run.text.length === 0 ? 0 : clamped / entry.run.text.length;
  return entry.run.x + entry.run.w * ratio;
}

function needsInterRunSpace(
  previous: SelectedTextRun,
  current: SelectedTextRun,
  previousOut: string,
): boolean {
  if (/\s$/u.test(previousOut) || /^\s/u.test(current.text)) return false;
  const gap = current.run.x - (previous.run.x + previous.run.w);
  return gap > Math.max(1.5, Math.min(previous.run.h, current.run.h) * 0.15);
}

function inferContentTextStyle(
  runs: TextRunDisplayBounds[],
  rects: ContentTextOverlay["coverRects"],
  fallback: TextDefaults,
): Pick<ContentTextOverlay, "fontSize" | "color" | "bold" | "italic" | "fontFamily"> {
  const cssFontSizes = runs
    .map((run) => run.cssFontSizePt)
    .filter(
      (size): size is number =>
        typeof size === "number" && Number.isFinite(size) && size > 0,
    );
  const pdfFontSizes = runs
    .map((run) => run.fontSizePt)
    .filter(
      (size): size is number =>
        typeof size === "number" && Number.isFinite(size) && size > 0,
    );
  const cssMedian = cssFontSizes.length > 0 ? median(cssFontSizes) : null;
  const pdfMedian = pdfFontSizes.length > 0 ? median(pdfFontSizes) : null;
  // The pdf size is the text-matrix scale — the exact size the glyphs were
  // drawn at — so it wins when present. Keep sub-pt precision: papers use
  // sizes like 9.96pt, and rounding to whole points is visible after
  // re-render.
  const preferred = pdfMedian ?? cssMedian;
  const fontSize =
    preferred !== null
      ? Math.max(6, Math.min(144, Math.round(preferred * 100) / 100))
      : estimateFontSize(rects, fallback.fontSize);
  return {
    fontSize,
    color: "#000000",
    bold: inferBold(runs),
    italic: inferItalic(runs),
    fontFamily: inferFontFamily(runs, fallback.fontFamily),
  };
}

function inferBold(runs: TextRunDisplayBounds[]): boolean {
  if (runs.length === 0) return false;
  let weighted = 0;
  for (const run of runs) {
    const raw = [
      run.fontName,
      run.fontFamily,
      run.cssFontFamily,
      run.cssFontWeight,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const numericWeight = Number.parseInt(run.cssFontWeight ?? "", 10);
    if (
      (Number.isFinite(numericWeight) && numericWeight >= 600) ||
      /\b(bold|black|heavy|demi[-\s]?bold|semi[-\s]?bold)\b|cmbx|nimbus(?:rom|san)[^\s,]*[-_]?bold|nimbus(?:rom|san)[^\s,]*[-_]?med/u.test(raw)
    ) {
      weighted += 1;
    }
  }
  return weighted / runs.length >= 0.5;
}

function inferItalic(runs: TextRunDisplayBounds[]): boolean {
  if (runs.length === 0) return false;
  let styled = 0;
  for (const run of runs) {
    const raw = [
      run.fontName,
      run.fontFamily,
      run.cssFontFamily,
      run.cssFontStyle,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (
      /\b(italic|oblique|slanted)\b|[-_](?:it|obl|sl)(?:\b|[-_\d])|cm(?:ti|sl)|cmmib|nimbus(?:rom|san)[^\s,]*[-_]?(?:ital|obli)/u.test(raw)
    ) {
      styled += 1;
    }
  }
  return styled / runs.length >= 0.5;
}

function inferFontFamily(
  runs: TextRunDisplayBounds[],
  fallback: TextDefaults["fontFamily"],
): TextDefaults["fontFamily"] {
  if (runs.length === 0) return fallback;
  const scores: Record<TextDefaults["fontFamily"], number> = {
    sans: 0,
    serif: 0,
    mono: 0,
    notoSansSc: 0,
    notoSansJp: 0,
  };
  for (const run of runs) {
    const inferred =
      classifySpecificFontFamily(run.fontName) ??
      classifySpecificFontFamily(run.fontFamily) ??
      classifySpecificFontFamily(run.cssFontFamily) ??
      classifyGenericFontFamily(run.fontFamily) ??
      classifyGenericFontFamily(run.cssFontFamily);
    scores[inferred ?? fallback] += 1;
  }
  return (Object.entries(scores) as Array<[TextDefaults["fontFamily"], number]>)
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? fallback;
}

function classifySpecificFontFamily(
  rawFamily: string | undefined,
): TextDefaults["fontFamily"] | null {
  if (!rawFamily || isGenericCssFontFamily(rawFamily)) return null;
  const raw = rawFamily.toLowerCase();
  if (/noto\s+sans\s+jp|source\s+han\s+sans\s+jp|hiragino|yu\s+gothic/u.test(raw)) {
    return "notoSansJp";
  }
  if (
    /noto\s+sans\s+sc|source\s+han\s+sans\s+sc|pingfang|microsoft\s+yahei|heiti/u.test(raw)
  ) {
    return "notoSansSc";
  }
  if (
    /courier|mono|monospace|consola|menlo|cmtt|lmtt|nimbusmon|beramono|sftt|typewriter/u.test(raw)
  ) {
    return "mono";
  }
  if (
    /serif|times|roman|nimbusrom|cmr|cmbx|cmti|cmsl|cmmib|lmr|lmroman|texgyretermes|minion|garamond|cambria|georgia|palatino|libertine|baskerville|caslon/u.test(raw)
  ) {
    return "serif";
  }
  if (/sans|arial|helvetica|calibri|verdana|frutiger|univers|cmss|lmss|texgyreheros/u.test(raw)) {
    return "sans";
  }
  return null;
}

function classifyGenericFontFamily(
  rawFamily: string | undefined,
): TextDefaults["fontFamily"] | null {
  if (!rawFamily) return null;
  const normalized = rawFamily
    .split(",")
    .map((part) => part.trim().replace(/^['"]|['"]$/g, "").toLowerCase())
    .filter(Boolean);
  if (normalized.includes("serif") && !normalized.includes("sans-serif")) {
    return "serif";
  }
  if (normalized.includes("monospace")) return "mono";
  if (normalized.includes("sans-serif")) return "sans";
  return null;
}

function samplePageColors(
  root: HTMLElement | null,
  rects: DisplayRect[],
): { backgroundColor: string | null; textColor: string | null } {
  if (!root || rects.length === 0) {
    return { backgroundColor: null, textColor: null };
  }
  const pageEl = root.closest<HTMLElement>(".shioriPage");
  const canvas = pageEl?.querySelector<HTMLCanvasElement>(".shioriPageCanvas");
  if (!canvas || canvas.width === 0 || canvas.height === 0) {
    return { backgroundColor: null, textColor: null };
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return { backgroundColor: null, textColor: null };

  const rootBounds = root.getBoundingClientRect();
  const canvasBounds = canvas.getBoundingClientRect();
  if (canvasBounds.width <= 0 || canvasBounds.height <= 0) {
    return { backgroundColor: null, textColor: null };
  }
  const sx = canvas.width / canvasBounds.width;
  const sy = canvas.height / canvasBounds.height;
  const toCanvasPoint = (x: number, y: number) => ({
    x: (rootBounds.left + x - canvasBounds.left) * sx,
    y: (rootBounds.top + y - canvasBounds.top) * sy,
  });

  const backgroundSamples: Rgb[] = [];
  const textSamples: Rgb[] = [];
  for (const rect of rects) {
    const gap = Math.max(1.5, Math.min(6, rect.h * 0.2));
    const bgPoints = [
      [rect.x + rect.w / 2, rect.y - gap],
      [rect.x + rect.w / 2, rect.y + rect.h + gap],
      [rect.x - gap, rect.y + rect.h / 2],
      [rect.x + rect.w + gap, rect.y + rect.h / 2],
      [rect.x - gap, rect.y - gap],
      [rect.x + rect.w + gap, rect.y + rect.h + gap],
    ] as const;
    for (const [x, y] of bgPoints) {
      const sample = sampleCanvasPoint(ctx, toCanvasPoint(x, y));
      if (sample) backgroundSamples.push(sample);
    }

    const cols = Math.max(3, Math.min(10, Math.floor(rect.w / 6)));
    const rows = Math.max(2, Math.min(5, Math.floor(rect.h / 4)));
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const x = rect.x + ((col + 0.5) / cols) * rect.w;
        const y = rect.y + ((row + 0.5) / rows) * rect.h;
        const sample = sampleCanvasPoint(ctx, toCanvasPoint(x, y));
        if (sample) textSamples.push(sample);
      }
    }
  }

  const lightBackgrounds = backgroundSamples.filter((rgb) => luminance(rgb) > 128);
  const background = medianRgb(
    lightBackgrounds.length > 0 ? lightBackgrounds : backgroundSamples,
  );
  const backgroundLum = background ? luminance(background) : 255;
  const inkCandidates = textSamples
    .filter((rgb) => luminance(rgb) < backgroundLum - 30)
    .sort((a, b) => luminance(a) - luminance(b));
  const darkestCount = Math.max(1, Math.ceil(inkCandidates.length * 0.25));
  return {
    backgroundColor: background ? rgbToHex(background) : null,
    textColor:
      inkCandidates.length > 0
        ? rgbToHex(medianRgb(inkCandidates.slice(0, darkestCount))!)
        : null,
  };
}

type Rgb = { r: number; g: number; b: number };

function sampleCanvasPoint(
  ctx: CanvasRenderingContext2D,
  point: { x: number; y: number },
): Rgb | null {
  const x = Math.floor(point.x);
  const y = Math.floor(point.y);
  if (x < 0 || y < 0 || x >= ctx.canvas.width || y >= ctx.canvas.height) {
    return null;
  }
  try {
    const data = ctx.getImageData(x, y, 1, 1).data;
    const alpha = data[3] ?? 0;
    if (alpha === 0) return null;
    return {
      r: data[0] ?? 0,
      g: data[1] ?? 0,
      b: data[2] ?? 0,
    };
  } catch {
    return null;
  }
}

function medianRgb(samples: Rgb[]): Rgb | null {
  if (samples.length === 0) return null;
  return {
    r: Math.round(median(samples.map((sample) => sample.r))),
    g: Math.round(median(samples.map((sample) => sample.g))),
    b: Math.round(median(samples.map((sample) => sample.b))),
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : sorted[mid] ?? 0;
}

function luminance(rgb: Rgb): number {
  return 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
}

function rgbToHex(rgb: Rgb): string {
  const hex = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, "0");
  return `#${hex(rgb.r)}${hex(rgb.g)}${hex(rgb.b)}`;
}

function unionPdfRects(rects: ContentTextOverlay["coverRects"]) {
  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.w));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.h));
  return {
    x: minX,
    y: minY,
    w: Math.max(1, maxX - minX),
    h: Math.max(1, maxY - minY),
  };
}

function expandPdfRect(
  rect: ContentTextOverlay["rect"],
  pad: number,
  page: PageModel,
): ContentTextOverlay["rect"] {
  return expandPdfRectSides(rect, { left: pad, right: pad, vertical: pad }, page);
}

function expandPdfRectSides(
  rect: ContentTextOverlay["rect"],
  pad: { left: number; right: number; vertical: number },
  page: PageModel,
): ContentTextOverlay["rect"] {
  const x = Math.max(0, rect.x - pad.left);
  const y = Math.max(0, rect.y - pad.vertical);
  const right = Math.min(page.widthPt, rect.x + rect.w + pad.right);
  const top = Math.min(page.heightPt, rect.y + rect.h + pad.vertical);
  return {
    x,
    y,
    w: Math.max(1, right - x),
    h: Math.max(1, top - y),
  };
}

// The edit rect is a visual container only: vertical placement of the text
// (on-screen textarea and export) derives from sourceBaselinesPt, so the rect
// carries no baseline semantics and no vertical nudge.
function contentTextEditRect(
  sourceRects: ContentTextOverlay["coverRects"],
  page: PageModel,
): ContentTextOverlay["rect"] {
  const source = unionPdfRects(sourceRects);
  const vertical = expandPdfRect(source, 0.8, page);
  const x = source.x;
  const right = Math.min(
    page.widthPt,
    source.x + source.w + CONTENT_TEXT_EDIT_RIGHT_PAD_PT,
  );
  return {
    x,
    y: vertical.y,
    w: Math.max(1, right - x),
    h: vertical.h,
  };
}

// Where the FIRST covered line starts relative to the edit rect's left edge
// (points). A selection that begins mid-line covers a first-line segment
// that starts right of the following full lines — without this offset the
// first replacement line renders flush against the box and overlaps the
// uncovered first half of the source line. Undefined when the first line
// already sits at the box edge (single-line edits, whole-line selections).
function contentTextFirstLineIndentPt(
  sourceRects: ContentTextOverlay["coverRects"],
  editRect: ContentTextOverlay["rect"],
): number | undefined {
  if (sourceRects.length < 2) return undefined;
  const top = sourceRects.reduce((best, rect) =>
    rect.y + rect.h > best.y + best.h ? rect : best,
  );
  const topCenter = top.y + top.h / 2;
  const firstLineMinX = Math.min(
    ...sourceRects
      .filter(
        (rect) =>
          Math.abs(rect.y + rect.h / 2 - topCenter) <=
          Math.max(rect.h, top.h) * 0.55,
      )
      .map((rect) => rect.x),
  );
  const indent = firstLineMinX - editRect.x;
  // Guard against noise and degenerate geometry (rotated pages, overlapping
  // rects): only a clearly positive indent inside the box is meaningful.
  if (!(indent > 0.5) || indent >= editRect.w) return undefined;
  return indent;
}

// Per-line source baselines (page space, top line first) from the selected
// pdf.js runs. Returns null when any line only has DOM-derived runs (no exact
// baseline): the overlay then omits sourceBaselinesPt and every consumer uses
// the legacy rect-edge math — an estimated baseline would silently reintroduce
// the misalignment this field exists to fix.
function sourceBaselinesFromRuns(
  runs: TextRunDisplayBounds[],
  page: PageModel,
  scale: number,
): number[] | null {
  if (runs.length === 0) return null;
  const lines: TextRunDisplayBounds[][] = [];
  for (const run of runs) {
    const current = lines[lines.length - 1];
    if (current && sameTextLine(current[0]!, run)) current.push(run);
    else lines.push([run]);
  }
  const baselines: number[] = [];
  for (const line of lines) {
    const ys = line
      .map((run) => run.baselineY)
      .filter((y): y is number => typeof y === "number" && Number.isFinite(y));
    if (ys.length === 0) return null;
    const displayY = median(ys);
    baselines.push(
      displayToPdf(
        { x: 0, y: displayY },
        page.widthPt,
        page.heightPt,
        page.rotation,
        scale,
      ).y,
    );
  }
  return baselines;
}

function estimateFontSize(
  rects: ContentTextOverlay["coverRects"],
  fallback: number,
): number {
  const heights = rects.map((rect) => rect.h).filter((height) => height > 0);
  if (heights.length === 0) return fallback;
  const sorted = [...heights].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? fallback;
  return Math.max(6, Math.min(144, Math.round(median)));
}

function cssPxToPt(
  value: string,
  pageWidthPx: number,
  pageWidthPt: number,
): number | undefined {
  const px = Number.parseFloat(value);
  if (!Number.isFinite(px) || px <= 0 || pageWidthPx <= 0) return undefined;
  return px * (pageWidthPt / pageWidthPx);
}

function dominantCssFontFamily(
  runs: TextRunDisplayBounds[],
  inferredFamily: TextDefaults["fontFamily"],
): string | undefined {
  const families = runs
    .map((r) => r.cssFontFamily)
    .filter(
      (f): f is string =>
        typeof f === "string" && f.length > 0 && !isGenericCssFontFamily(f),
    );
  if (families.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const f of families) {
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  let best = families[0]!;
  let bestCount = 0;
  for (const [family, count] of counts) {
    if (count > bestCount) {
      best = family;
      bestCount = count;
    }
  }
  if (inferredFamily === "serif" && /\bsans-serif\b/i.test(best)) {
    return undefined;
  }
  if (inferredFamily === "mono" && !/\b(mono|monospace|courier)\b/i.test(best)) {
    return undefined;
  }
  return best;
}

function isGenericCssFontFamily(family: string): boolean {
  const normalized = family
    .split(",")
    .map((part) => part.trim().replace(/^['"]|['"]$/g, "").toLowerCase())
    .filter(Boolean);
  if (normalized.length === 0) return true;
  return normalized.every((part) =>
    part === "serif" || part === "sans-serif" || part === "monospace"
  );
}

export {
  textBoxDisplayRect,
  textMarkupDefaults,
  pdfRectsOverlap,
  expandPdfRectSides,
  contentTextEditRect,
  sourceBaselinesFromRuns,
  contentTextFirstLineIndentPt,
  samplePageColors,
  inferContentTextStyle,
  dominantCssFontFamily,
  summarizeContentTextOverlay,
  summarizePdfRect,
  summarizeDisplayRect,
  summarizeClientRect,
  summarizeGesture,
  summarizeSelectedTextRun,
  summarizeTextRun,
  roundDebug,
  textGestureDistance,
  hasActiveTextSelection,
  rangeIntersectsNode,
  safeCompare,
  selectedTextRunsForRange,
  selectedTextRunsForDisplayRects,
  isSpuriousFullLayerSelection,
  filterSelectedRunTexts,
  trimSelectedRunTextsToGesture,
  selectedTextFromRunTexts,
  selectedTextFromSelection,
  selectedRunRectsWithEdges,
  displayRectsFromSelectedRunTexts,
  isBlankTextClick,
  isPdfTextTarget,
  searchHighlightDisplayRects,
  buildSemanticClipboardText,
  isPurePdfTextSelection,
};
export type {
  Point,
  TextGesture,
  SelectedTextRun,
  SemanticCopyLayerModel,
  TextRunGeometryLayerModel,
  TextMarkupType,
  CoverEdgeSafety,
};
