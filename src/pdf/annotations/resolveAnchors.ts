import type { PdfPageTextContent as TextContent } from "../engine/text";
import type { Overlay, OverlayTextAnchor, PageModel } from "../model/types";
import {
  SearchTextLimitError,
  buildSearchTextIndex,
  compileSearchQuery,
  iterateSearchRanges,
  makeSearchSnippet,
  type CompiledSearchQuery,
  type SearchIgnoredRange,
  type SearchSourceRange,
  type SearchTextIndex,
} from "../../editor/search/findMatches";
import {
  buildSemanticTextLayerModel,
  SemanticTextLimitError,
  semanticTextContentCost,
  semanticUnitsToSearchIndex,
  type SemanticSearchIndex,
  type SemanticTextUnit,
} from "../../editor/textSelection/semanticText";
import {
  AnchorGeometryLimitError,
  charRangeToPageRects,
  textContentToPdfRunMap,
  type ActualTextGeometryCacheEntry,
  type CharRangeRects,
  type PdfTextRun,
} from "./anchorGeometry";
import {
  MAX_RECTS_PER_ANNOTATION,
  MAX_TOTAL_RECTS_PER_SPEC,
  annotationSpecViolation,
} from "./spec";

// Resolves quote anchors into plain coordinate annotations BEFORE
// parseAnnotationSpec runs. The parser, overlay-id derivation, export, and
// the Live API idempotency machinery never see an anchor — by construction.
// Anchor PROVENANCE still reaches the final overlays, but through a side
// channel (`onAnchorResolved` + `attachResolvedAnchors`) rather than the spec,
// so the spec bytes — and every operation id derived from them — are
// untouched.
// Matching reuses the search pipeline (semantic index + shared matcher), so
// search and anchors agree on text ranges (including CJK and replacement text
// when the PDF runtime actually exposes it).
// Placement still requires usable glyph geometry; matches on vertical,
// rotated, scanned, or geometry-less text fail with explicit-rect guidance.

export type AnchorPageText = {
  pageNumber: number;
  index: SemanticSearchIndex;
  searchIndex: SearchTextIndex;
  alternateSearchIndexes: SearchTextIndex[];
  units: SemanticTextUnit[];
  runs: Array<PdfTextRun | null>;
  visibleRuns: boolean[];
  sourceItemCount: number;
  sourceCharacterCount: number;
  runCount: number;
};

export function buildAnchorPageText(
  pageNumber: number,
  textContent: TextContent,
  page: PageModel,
): AnchorPageText {
  try {
    const units = buildSemanticTextLayerModel(textContent).units;
    // buildSemanticTextLayerModel performs the O(1) item-count gate before
    // semanticTextContentCost walks the source array.
    const cost = semanticTextContentCost(textContent);
    const index = semanticUnitsToSearchIndex(units);
    const searchIndex = buildSearchTextIndex(index.text);
    const runMap = textContentToPdfRunMap(textContent, page);
    return {
      pageNumber,
      index,
      searchIndex,
      alternateSearchIndexes: buildLayoutSearchIndexes(index, searchIndex),
      units,
      runs: runMap.runs,
      visibleRuns: runMap.visibleRuns,
      sourceItemCount: cost.items,
      sourceCharacterCount: cost.sourceCharacters,
      runCount: runMap.runs.length,
    };
  } catch (error) {
    if (
      error instanceof SemanticTextLimitError ||
      error instanceof SearchTextLimitError
    ) {
      throw new AnchorTextUnavailableError(
        `Page ${pageNumber} has too much text to anchor safely; narrow the operation or use explicit geometry`,
      );
    }
    throw error;
  }
}

export class AnchorResolutionError extends Error {
  constructor(message: string) {
    super(boundMessage(message));
    this.name = "AnchorResolutionError";
  }
}

export class AnchorTextUnavailableError extends Error {
  constructor(message: string) {
    super(boundMessage(message));
    this.name = "AnchorTextUnavailableError";
  }
}

/** Search normal text plus layout-only projections in source order, without
 * returning the same source range twice. */
export function* iterateAnchorSearchRanges(
  page: Pick<
    AnchorPageText,
    "index" | "searchIndex" | "alternateSearchIndexes"
  >,
  query: CompiledSearchQuery,
): Generator<SearchSourceRange> {
  const iterators = [page.searchIndex, ...page.alternateSearchIndexes].map(
    (index) => iterateSearchRanges(index, query),
  );
  const heads = iterators.map((iterator) => iterator.next());
  while (heads.some((head) => !head.done)) {
    let selected: SearchSourceRange | null = null;
    for (const head of heads) {
      if (head.done) continue;
      const value = head.value;
      if (
        selected === null ||
        value.index < selected.index ||
        (value.index === selected.index && value.end < selected.end)
      ) {
        selected = value;
      }
    }
    if (selected === null) return;
    const crossesHardBreak = rangeIntersectsSortedBreaks(
      selected,
      page.index.hardBreaks,
    );
    heads.forEach((head, index) => {
      if (
        !head.done &&
        head.value.index === selected!.index &&
        head.value.end === selected!.end
      ) {
        heads[index] = iterators[index]!.next();
      }
    });
    if (!crossesHardBreak) yield selected;
  }
}

/** `hardBreaks` are emitted in source order and never overlap. Locate the
 * first break whose end is after the match start instead of scanning every
 * paragraph separator for every match. */
function rangeIntersectsSortedBreaks(
  range: SearchSourceRange,
  hardBreaks: ReadonlyArray<{ start: number; end: number }>,
): boolean {
  let low = 0;
  let high = hardBreaks.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (hardBreaks[middle]!.end <= range.index) low = middle + 1;
    else high = middle;
  }
  const candidate = hardBreaks[low];
  return candidate !== undefined && candidate.start < range.end;
}

function buildLayoutSearchIndexes(
  index: SemanticSearchIndex,
  normal: SearchTextIndex,
): SearchTextIndex[] {
  if (index.layoutBreaks.length === 0) return [];
  const joinedRanges: SearchIgnoredRange[] = index.layoutBreaks.map(
    ({ start, end }) => ({ start, end }),
  );
  const dehyphenatedRanges: SearchIgnoredRange[] = index.layoutBreaks.map(
    ({ start, end, dehyphenateStart }) => ({
      start: dehyphenateStart ?? start,
      end,
    }),
  );
  const output: SearchTextIndex[] = [];
  const add = (candidate: SearchTextIndex) => {
    if (
      candidate.folded !== normal.folded &&
      !output.some((existing) => existing.folded === candidate.folded)
    ) {
      output.push(candidate);
    }
  };
  add(buildSearchTextIndex(index.text, undefined, joinedRanges));
  if (
    dehyphenatedRanges.some(
      (range, rangeIndex) => range.start !== joinedRanges[rangeIndex]!.start,
    )
  ) {
    add(buildSearchTextIndex(index.text, undefined, dehyphenatedRanges));
  }
  return output;
}

/** Cheap pre-scan so anchor-free specs skip the pdfjs text pass entirely. */
export function specHasAnchors(spec: unknown): boolean {
  if (!isObject(spec) || !Array.isArray(spec.annotations)) return false;
  return spec.annotations.some(
    (annotation) => isObject(annotation) && annotation.anchor != null,
  );
}

const MAX_LISTED_CANDIDATES = 8;
export const MAX_ANCHOR_SEARCH_WORK = 50_000_000;
export const MAX_ANCHOR_INDEXED_TEXT_CHARACTERS = 8_000_000;
export const MAX_ANCHOR_INDEXED_TEXT_UNITS = 500_000;
export const MAX_ANCHOR_INDEXED_TEXT_SPANS = 150_000;
export const MAX_ANCHOR_SEARCH_MAPPING_EXCEPTIONS = 100_000;
export const MAX_ANCHOR_SOURCE_ITEMS = 300_000;
export const MAX_ANCHOR_SOURCE_CHARACTERS = 8_000_000;
export const MAX_ANCHOR_RETAINED_RUNS = 300_000;
export const MAX_ANCHOR_GEOMETRY_WORK = 1_000_000;
// The Live API bounds completion error messages at 2 KiB; anchor errors must
// survive that path intact.
const MAX_ERROR_MESSAGE_BYTES = 2_048;

type AnchorMatch = {
  pageNumber: number;
  pageOccurrence: number;
  globalOccurrence: number;
  start: number;
  end: number;
  snippet: string;
  page: AnchorPageText;
};

type MatchLookupResult =
  | { kind: "none"; count: 0 }
  | { kind: "selected"; match: AnchorMatch }
  | { kind: "missingOccurrence"; count: number }
  | { kind: "ambiguous"; count: number; candidates: AnchorMatch[] };

type AnchorGeometryContext = {
  remainingWork: number;
  totalOutputRects: number;
  rangeCache: Map<string, CharRangeRects>;
  actualTextCaches: WeakMap<
    AnchorPageText,
    Map<number, ActualTextGeometryCacheEntry>
  >;
};

export type AnchorResolutionOptions = {
  /** Approximate folded page characters scanned across distinct selectors. */
  maxSearchWork?: number;
  /** Unique page text retained for geometry across this operation. */
  maxIndexedTextCharacters?: number;
  maxIndexedTextUnits?: number;
  maxIndexedTextSpans?: number;
  maxSearchMappingExceptions?: number;
  maxSourceItems?: number;
  maxSourceCharacters?: number;
  maxRetainedRuns?: number;
  maxGeometryWork?: number;
  /** Caller-owned cancellation/deadline hook. Throwing aborts resolution.
   * Live callers can close over an AbortSignal or absolute deadline. */
  checkAbort?: () => void;
  /**
   * Reports where each anchored annotation actually landed (exact matched
   * text, resolved page, page-local occurrence), keyed by its index in
   * `spec.annotations`. Callers hand the collected map to
   * `attachResolvedAnchors` after parsing so overlays carry the provenance
   * the spec deliberately does not.
   */
  onAnchorResolved?: (annotationIndex: number, anchor: OverlayTextAnchor) => void;
};

/**
 * Copies resolved-anchor provenance onto the overlays parsed from the same
 * spec. Index-aligned with `spec.annotations`; parseAnnotationSpec returns
 * exactly one overlay per annotation in order, so positions correspond.
 */
export function attachResolvedAnchors(
  overlays: Overlay[],
  anchors:
    | ReadonlyMap<number, OverlayTextAnchor>
    | undefined,
): Overlay[] {
  if (!anchors || anchors.size === 0) return overlays;
  return overlays.map((overlay, index) => {
    const anchor = anchors.get(index);
    return anchor ? { ...overlay, anchor } : overlay;
  });
}

/**
 * Returns the spec with every `anchor` replaced by resolved geometry
 * (`page` + `rects`/`targetRects`/`at` + informational `quote`). Anchor-free specs are
 * returned as the SAME reference. `getPage` is memoized internally, so
 * callers may pass a plain per-call loader.
 */
export async function resolveAnnotationSpecAnchors(
  spec: unknown,
  pageCount: number,
  getPage: (pageNumber: number) => Promise<AnchorPageText>,
  options: AnchorResolutionOptions = {},
): Promise<unknown> {
  if (!specHasAnchors(spec)) return spec;
  options.checkAbort?.();
  const source = spec as Record<string, unknown>;
  const annotations = source.annotations as unknown[];
  const violation = annotationSpecViolation(annotations);
  if (violation) throw new AnchorResolutionError(violation);

  let remainingIndexedTextCharacters = safeBudget(
    options.maxIndexedTextCharacters,
    MAX_ANCHOR_INDEXED_TEXT_CHARACTERS,
  );
  let remainingIndexedTextUnits = safeBudget(
    options.maxIndexedTextUnits,
    MAX_ANCHOR_INDEXED_TEXT_UNITS,
  );
  let remainingIndexedTextSpans = safeBudget(
    options.maxIndexedTextSpans,
    MAX_ANCHOR_INDEXED_TEXT_SPANS,
  );
  let remainingSearchMappingExceptions = safeBudget(
    options.maxSearchMappingExceptions,
    MAX_ANCHOR_SEARCH_MAPPING_EXCEPTIONS,
  );
  let remainingSourceItems = safeBudget(
    options.maxSourceItems,
    MAX_ANCHOR_SOURCE_ITEMS,
  );
  let remainingSourceCharacters = safeBudget(
    options.maxSourceCharacters,
    MAX_ANCHOR_SOURCE_CHARACTERS,
  );
  let remainingRetainedRuns = safeBudget(
    options.maxRetainedRuns,
    MAX_ANCHOR_RETAINED_RUNS,
  );
  const pageCache = new Map<number, Promise<AnchorPageText>>();
  const loadPage = (pageNumber: number): Promise<AnchorPageText> => {
    let cached = pageCache.get(pageNumber);
    if (!cached) {
      cached = getPage(pageNumber).then((page) => {
        options.checkAbort?.();
        const searchIndexes = [
          page.searchIndex,
          ...page.alternateSearchIndexes,
        ];
        const searchMappingExceptions = searchIndexes.reduce(
          (total, index) => total + index.mappingExceptions.length,
          0,
        );
        if (
          page.index.text.length > remainingIndexedTextCharacters ||
          page.units.length > remainingIndexedTextUnits ||
          page.index.spans.length > remainingIndexedTextSpans ||
          searchMappingExceptions > remainingSearchMappingExceptions ||
          page.sourceItemCount > remainingSourceItems ||
          page.sourceCharacterCount > remainingSourceCharacters ||
          page.runCount > remainingRetainedRuns
        ) {
          throw new AnchorResolutionError(
            "Anchor text index exceeds the safe retained-text budget; narrow anchors with anchor.page or use explicit geometry",
          );
        }
        remainingIndexedTextCharacters -= page.index.text.length;
        remainingIndexedTextUnits -= page.units.length;
        remainingIndexedTextSpans -= page.index.spans.length;
        remainingSearchMappingExceptions -= searchMappingExceptions;
        remainingSourceItems -= page.sourceItemCount;
        remainingSourceCharacters -= page.sourceCharacterCount;
        remainingRetainedRuns -= page.runCount;
        return page;
      });
      pageCache.set(pageNumber, cached);
    }
    return cached;
  };
  const searchBudget = {
    remaining: safeBudget(options.maxSearchWork, MAX_ANCHOR_SEARCH_WORK),
  };
  const lookupCache = new Map<string, Promise<MatchLookupResult>>();
  const geometry: AnchorGeometryContext = {
    remainingWork: safeBudget(
      options.maxGeometryWork,
      MAX_ANCHOR_GEOMETRY_WORK,
    ),
    totalOutputRects: annotations.reduce<number>(
      (total, annotation) =>
        total +
        (isObject(annotation)
          ? (Array.isArray(annotation.rects) ? annotation.rects.length : 0) +
            (Array.isArray(annotation.targetRects)
              ? annotation.targetRects.length
              : 0)
          : 0),
      0,
    ),
    rangeCache: new Map(),
    actualTextCaches: new WeakMap(),
  };
  const lookupMatches = (
    quote: string,
    anchorPage: number | null,
    occurrence: number | null,
    path: string,
  ): Promise<MatchLookupResult> => {
    const query = compileSearchQuery(quote);
    const key = JSON.stringify([query.folded, anchorPage, occurrence]);
    let cached = lookupCache.get(key);
    if (!cached) {
      cached = findAnchorMatches(
        query,
        anchorPage,
        occurrence,
        pageCount,
        loadPage,
        searchBudget,
        path,
        options.checkAbort,
      );
      lookupCache.set(key, cached);
    }
    return cached;
  };

  const resolved: unknown[] = [];
  for (let index = 0; index < annotations.length; index += 1) {
    options.checkAbort?.();
    const annotation = annotations[index];
    if (!isObject(annotation) || annotation.anchor == null) {
      resolved.push(annotation);
      continue;
    }
    const { annotation: resolvedAnnotation, provenance } =
      await resolveAnchoredAnnotation(
        annotation,
        `annotations[${index}]`,
        pageCount,
        lookupMatches,
        geometry,
        options.checkAbort,
      );
    options.checkAbort?.();
    options.onAnchorResolved?.(index, provenance);
    resolved.push(resolvedAnnotation);
  }
  options.checkAbort?.();
  return { ...source, annotations: resolved };
}

async function resolveAnchoredAnnotation(
  annotation: Record<string, unknown>,
  path: string,
  pageCount: number,
  lookupMatches: (
    quote: string,
    anchorPage: number | null,
    occurrence: number | null,
    path: string,
  ) => Promise<MatchLookupResult>,
  geometry: AnchorGeometryContext,
  checkAbort: (() => void) | undefined,
): Promise<{
  annotation: Record<string, unknown>;
  provenance: OverlayTextAnchor;
}> {
  const anchor = annotation.anchor;
  if (
    !isObject(anchor) ||
    typeof anchor.quote !== "string" ||
    anchor.quote.trim().length === 0
  ) {
    throw new AnchorResolutionError(
      `${path}.anchor.quote must be a non-empty string`,
    );
  }
  // Strict unknown-key policy, mirrored from annotationSpecViolation: live
  // requests reach this resolver without the CLI's pre-check.
  for (const key of Object.keys(anchor)) {
    if (key !== "quote" && key !== "page" && key !== "occurrence") {
      throw new AnchorResolutionError(`${path}.anchor.${key} is not supported`);
    }
  }
  const quote = anchor.quote;
  const anchorPage = optionalOneBasedInteger(
    anchor.page,
    `${path}.anchor.page`,
  );
  const occurrence = optionalOneBasedInteger(
    anchor.occurrence,
    `${path}.anchor.occurrence`,
  );
  if (anchorPage !== null && anchorPage > pageCount) {
    throw new AnchorResolutionError(
      `${path}.anchor.page is ${anchorPage} but the document has ${pageCount} pages`,
    );
  }

  const where =
    anchorPage !== null ? `on page ${anchorPage}` : `in pages 1-${pageCount}`;
  const lookup = await lookupMatches(quote, anchorPage, occurrence, path);
  if (lookup.kind === "none") {
    throw new AnchorResolutionError(
      `${path}.anchor.quote was not found ${where}; verify the quote with \`shiori search\` (scanned pages without a text layer cannot anchor, and quotes crossing a page boundary must be split)`,
    );
  }
  if (lookup.kind === "missingOccurrence") {
    throw new AnchorResolutionError(
      `${path}.anchor.occurrence is ${occurrence} but the quote matches ${lookup.count} time${lookup.count === 1 ? "" : "s"} ${where}`,
    );
  }
  if (lookup.kind === "ambiguous") {
    const listed = lookup.candidates
      .map(
        (match) =>
          `page ${match.pageNumber} occurrence ${match.pageOccurrence} (global occurrence ${match.globalOccurrence}): "${match.snippet}"`,
      )
      .join("; ");
    const suffix =
      lookup.count > MAX_LISTED_CANDIDATES
        ? `; and ${lookup.count - MAX_LISTED_CANDIDATES} more`
        : "";
    throw new AnchorResolutionError(
      `${path}.anchor.quote matches ${lookup.count} times ${where}; add anchor.page and/or anchor.occurrence to pick one: ${listed}${suffix}`,
    );
  }
  const selected = lookup.match;

  const geometryKey = `${selected.pageNumber}:${selected.start}:${selected.end}`;
  let resolvedGeometry = geometry.rangeCache.get(geometryKey);
  if (!resolvedGeometry) {
    let actualTextGeometryCache = geometry.actualTextCaches.get(selected.page);
    if (!actualTextGeometryCache) {
      actualTextGeometryCache = new Map();
      geometry.actualTextCaches.set(selected.page, actualTextGeometryCache);
    }
    const consumeWork = (amount: number) => {
      checkAbort?.();
      if (
        !Number.isSafeInteger(amount) ||
        amount < 0 ||
        amount > geometry.remainingWork
      ) {
        throw new AnchorResolutionError(
          `${path}.anchor geometry exceeds the safe work budget; use a shorter quote or explicit geometry`,
        );
      }
      geometry.remainingWork -= amount;
    };
    try {
      resolvedGeometry = charRangeToPageRects(
        { start: selected.start, end: selected.end },
        selected.page.index,
        selected.page.units,
        selected.page.runs,
        selected.page.visibleRuns,
        {
          maxRects: MAX_RECTS_PER_ANNOTATION,
          consumeWork,
          actualTextGeometryCache,
        },
      );
    } catch (error) {
      if (error instanceof AnchorGeometryLimitError) {
        throw new AnchorResolutionError(`${path}.${error.message}`);
      }
      throw error;
    }
    geometry.rangeCache.set(geometryKey, resolvedGeometry);
  }
  const { rects, unresolvedUnits } = resolvedGeometry;
  if (unresolvedUnits > 0 || rects.length === 0) {
    throw new AnchorResolutionError(
      `${path}.anchor.quote matched on page ${selected.pageNumber} but overlaps text without usable geometry (vertical or rotated text); use explicit rects for this annotation`,
    );
  }

  const matchedText = selected.page.index.text.slice(selected.start, selected.end);
  // The provenance quote is the text that was actually hit — a later
  // re-anchor pass must search for what matched, not what was requested.
  const provenance: OverlayTextAnchor = {
    quote: matchedText,
    page: selected.pageNumber,
    occurrence: selected.pageOccurrence,
  };
  const rest: Record<string, unknown> = { ...annotation };
  delete rest.anchor;
  if (annotation.type === "note") {
    const first = rects[0]!;
    return {
      annotation: {
        ...rest,
        page: selected.pageNumber,
        at: { x: first.x, y: first.y },
      },
      provenance,
    };
  }
  if (rects.length > MAX_RECTS_PER_ANNOTATION) {
    throw new AnchorResolutionError(
      `${path}.anchor geometry exceeds ${MAX_RECTS_PER_ANNOTATION} rectangles`,
    );
  }
  geometry.totalOutputRects += rects.length;
  if (geometry.totalOutputRects > MAX_TOTAL_RECTS_PER_SPEC) {
    throw new AnchorResolutionError(
      `Spec cannot contain more than ${MAX_TOTAL_RECTS_PER_SPEC} rectangles in total`,
    );
  }
  return {
    annotation:
      annotation.type === "callout"
        ? {
            ...rest,
            page: selected.pageNumber,
            targetRects: rects,
            quote: matchedText,
          }
        : {
            ...rest,
            page: selected.pageNumber,
            rects,
            quote: matchedText,
          },
    provenance,
  };
}

async function findAnchorMatches(
  query: CompiledSearchQuery,
  anchorPage: number | null,
  requestedOccurrence: number | null,
  pageCount: number,
  loadPage: (pageNumber: number) => Promise<AnchorPageText>,
  budget: { remaining: number },
  path: string,
  checkAbort: (() => void) | undefined,
): Promise<MatchLookupResult> {
  if (!query.folded) return { kind: "none", count: 0 };
  const pageNumbers =
    anchorPage === null
      ? Array.from({ length: pageCount }, (_, index) => index + 1)
      : [anchorPage];
  let count = 0;
  const candidates: AnchorMatch[] = [];
  for (const pageNumber of pageNumbers) {
    checkAbort?.();
    const page = await loadPage(pageNumber);
    checkAbort?.();
    const work = Math.max(
      1,
      [page.searchIndex, ...page.alternateSearchIndexes].reduce(
        (total, index) => total + index.folded.length,
        0,
      ),
    );
    if (work > budget.remaining) {
      throw new AnchorResolutionError(
        `${path}.anchor search exceeds the safe work budget; narrow the quote with anchor.page or reduce distinct anchors`,
      );
    }
    budget.remaining -= work;
    let pageOccurrence = 0;
    for (const match of iterateAnchorSearchRanges(page, query)) {
      checkAbort?.();
      count += 1;
      pageOccurrence += 1;
      if (requestedOccurrence !== null && count === requestedOccurrence) {
        return {
          kind: "selected",
          match: anchorMatchForRange(page, pageOccurrence, count, match),
        };
      }
      if (candidates.length < MAX_LISTED_CANDIDATES) {
        candidates.push(
          anchorMatchForRange(page, pageOccurrence, count, match),
        );
      }
    }
    checkAbort?.();
  }
  if (requestedOccurrence !== null) {
    return { kind: "missingOccurrence", count };
  }
  if (count === 0) return { kind: "none", count: 0 };
  if (count === 1) return { kind: "selected", match: candidates[0]! };
  return { kind: "ambiguous", count, candidates };
}

function anchorMatchForRange(
  page: AnchorPageText,
  pageOccurrence: number,
  globalOccurrence: number,
  range: { index: number; end: number },
): AnchorMatch {
  const snippet = makeSearchSnippet(page.index.text, range.index, range.end);
  return {
    pageNumber: page.pageNumber,
    pageOccurrence,
    globalOccurrence,
    start: range.index,
    end: range.end,
    snippet: `${snippet.before}[${snippet.match}]${snippet.after}`,
    page,
  };
}

function optionalOneBasedInteger(value: unknown, path: string): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new AnchorResolutionError(`${path} must be a 1-based integer`);
  }
  return value;
}

function safeBudget(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? Math.min(Math.floor(value), fallback)
    : fallback;
}

function boundMessage(message: string): string {
  const encoder = new TextEncoder();
  const marker = "…";
  const markerBytes = encoder.encode(marker).byteLength;
  let bytes = 0;
  const characters: string[] = [];
  const sizes: number[] = [];
  for (const character of message) {
    const characterBytes = encoder.encode(character).byteLength;
    if (bytes + characterBytes > MAX_ERROR_MESSAGE_BYTES) {
      while (
        characters.length > 0 &&
        bytes + markerBytes > MAX_ERROR_MESSAGE_BYTES
      ) {
        characters.pop();
        bytes -= sizes.pop() ?? 0;
      }
      return `${characters.join("")}${marker}`;
    }
    characters.push(character);
    sizes.push(characterBytes);
    bytes += characterBytes;
  }
  return message;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
