import { FULL_CASE_FOLD_OVERRIDES } from "./unicodeCaseFold";

export type SearchPageText = {
  pageId: string;
  pageNumber: number;
  text: string;
};

export type SearchSnippet = {
  before: string;
  match: string;
  after: string;
};

export type SearchMatch = {
  pageId: string;
  pageNumber: number;
  /** Start/end in the original page text, never in the folded string. */
  index: number;
  end: number;
  snippet: SearchSnippet;
};

export type FindMatchesResult = {
  matches: SearchMatch[];
  /** True when the safe UI result cap hid at least one later match. */
  truncated: boolean;
};

export type IndexedSearchPage = Pick<
  SearchPageText,
  "pageId" | "pageNumber"
> & {
  index: SearchTextIndex;
};

export type SearchTextIndex = {
  /** The caller-provided text that match ranges address. */
  text: string;
  /** Whitespace-normalized, locale-independent Unicode-folded search text. */
  folded: string;
  /** Sparse spans where normalization changes string length. Everywhere
   * else source offsets advance one-for-one with folded offsets. */
  mappingExceptions: SearchMappingException[];
};

type SearchMappingException = {
  foldedStart: number;
  foldedEnd: number;
  sourceStart: number;
  sourceEnd: number;
  deltaAfter: number;
};

export type CompiledSearchQuery = {
  folded: string;
};

export type SearchSourceRange = { index: number; end: number };

export type SearchIgnoredRange = { start: number; end: number };

const SNIPPET_CONTEXT = 42;
export const MAX_FIND_MATCHES = 10_000;
export const MAX_SEARCH_MAPPING_EXCEPTIONS = 50_000;
export const MAX_DOCUMENT_SEARCH_MAPPING_EXCEPTIONS = 100_000;

export class SearchTextLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchTextLimitError";
  }
}

export function findMatches(
  pages: SearchPageText[],
  rawQuery: string,
): SearchMatch[] {
  return findMatchesWithStatus(pages, rawQuery).matches;
}

export function findMatchesWithStatus(
  pages: SearchPageText[],
  rawQuery: string,
): FindMatchesResult {
  return findMatchesInSearchIndexes(indexSearchPages(pages), rawQuery);
}

export function indexSearchPages(
  pages: SearchPageText[],
  options: { maxMappingExceptions?: number } = {},
): IndexedSearchPage[] {
  let remainingMappings = safeMappingBudget(
    options.maxMappingExceptions,
    MAX_DOCUMENT_SEARCH_MAPPING_EXCEPTIONS,
  );
  return pages.map((page) => {
    const index = buildSearchTextIndex(
      page.text,
      Math.min(MAX_SEARCH_MAPPING_EXCEPTIONS, remainingMappings),
    );
    remainingMappings -= index.mappingExceptions.length;
    return {
      pageId: page.pageId,
      pageNumber: page.pageNumber,
      index,
    };
  });
}

export function findMatchesInSearchIndexes(
  pages: IndexedSearchPage[],
  rawQuery: string,
): FindMatchesResult {
  const query = compileSearchQuery(rawQuery);
  if (!query.folded) return { matches: [], truncated: false };

  const matches: SearchMatch[] = [];
  for (const page of pages) {
    for (const range of iterateSearchRanges(page.index, query)) {
      if (matches.length >= MAX_FIND_MATCHES) {
        return { matches, truncated: true };
      }
      matches.push({
        pageId: page.pageId,
        pageNumber: page.pageNumber,
        ...range,
        snippet: makeSearchSnippet(
          page.index.text,
          range.index,
          range.end,
        ),
      });
    }
  }
  return { matches, truncated: false };
}

/**
 * Build the shared search representation used by CLI search and quote
 * anchors. Both input text and queries go through this exact transform:
 * Unicode whitespace folds to one ASCII space, leading/trailing whitespace
 * disappears, and case folding is locale-independent. The range table is
 * load-bearing because lowercase expansion (notably `İ` -> `i` + dot) means
 * folded offsets cannot safely index the original string.
 */
export function buildSearchTextIndex(
  text: string,
  maxMappingExceptions = MAX_SEARCH_MAPPING_EXCEPTIONS,
  ignoredSourceRanges: readonly SearchIgnoredRange[] = [],
): SearchTextIndex {
  const mappingLimit = safeMappingBudget(
    maxMappingExceptions,
    MAX_SEARCH_MAPPING_EXCEPTIONS,
  );
  const ignoredRanges = normalizeIgnoredRanges(text, ignoredSourceRanges);
  assertSearchMappingWithinLimit(text, mappingLimit, ignoredRanges);
  let folded = "";
  const mappingExceptions: SearchMappingException[] = [];
  let pendingWhitespace: { start: number; end: number } | null = null;
  let ignoredIndex = 0;

  const append = (
    chunk: string,
    start: number,
    end: number,
    wholeCluster = false,
  ) => {
    const foldedStart = folded.length;
    folded += chunk;
    const foldedEnd = folded.length;
    if (wholeCluster || chunk.length !== end - start) {
      if (mappingExceptions.length >= mappingLimit) {
        throw new SearchTextLimitError(
          `Search text exceeds the remaining ${mappingLimit} normalization mapping budget`,
        );
      }
      mappingExceptions.push({
        foldedStart,
        foldedEnd,
        sourceStart: start,
        sourceEnd: end,
        deltaAfter: end - foldedEnd,
      });
    }
  };

  const skipLeading = (end: number) => {
    if (mappingExceptions.length >= mappingLimit) {
      throw new SearchTextLimitError(
        `Search text exceeds the remaining ${mappingLimit} normalization mapping budget`,
      );
    }
    mappingExceptions.push({
      foldedStart: 0,
      foldedEnd: 0,
      sourceStart: 0,
      sourceEnd: end,
      deltaAfter: end,
    });
  };

  const skipIgnored = (range: SearchIgnoredRange) => {
    if (mappingExceptions.length >= mappingLimit) {
      throw new SearchTextLimitError(
        `Search text exceeds the remaining ${mappingLimit} normalization mapping budget`,
      );
    }
    mappingExceptions.push({
      foldedStart: folded.length,
      foldedEnd: folded.length,
      sourceStart: range.start,
      sourceEnd: range.end,
      deltaAfter: range.end - folded.length,
    });
  };

  for (const { segment, start, end } of searchClusters(text)) {
    while (
      ignoredIndex < ignoredRanges.length &&
      ignoredRanges[ignoredIndex]!.end <= start
    ) {
      ignoredIndex += 1;
    }
    const ignored = ignoredRanges[ignoredIndex];
    if (ignored && ignored.start <= start) {
      if (end > ignored.end) {
        throw invalidIgnoredRange(ignored);
      }
      if (start === ignored.start) skipIgnored(ignored);
      continue;
    }
    if (ignored && ignored.start < end) throw invalidIgnoredRange(ignored);
    if (/^\s+$/u.test(segment)) {
      pendingWhitespace = pendingWhitespace
        ? { start: pendingWhitespace.start, end }
        : { start, end };
      continue;
    }
    if (pendingWhitespace) {
      if (folded.length > 0) {
        append(" ", pendingWhitespace.start, pendingWhitespace.end);
      } else {
        skipLeading(pendingWhitespace.end);
      }
    }
    pendingWhitespace = null;
    const foldedSegment = deterministicCaseFold(segment);
    append(
      foldedSegment,
      start,
      end,
      requiresWholeClusterMapping(segment, foldedSegment),
    );
  }

  return {
    text,
    folded,
    mappingExceptions,
  };
}

export function compileSearchQuery(rawQuery: string): CompiledSearchQuery {
  // JSON can carry lone UTF-16 surrogates even though normal keyboard/CLI
  // input cannot. Letting one match half of a valid astral character would
  // return a half-code-point range and produce half-width anchor geometry.
  if (hasUnpairedSurrogate(rawQuery)) return { folded: "" };
  return { folded: buildSearchTextIndex(rawQuery).folded };
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function* iterateMatchesInSearchIndex(
  page: Pick<SearchPageText, "pageId" | "pageNumber">,
  index: SearchTextIndex,
  query: CompiledSearchQuery,
): Generator<SearchMatch> {
  for (const range of iterateSearchRanges(index, query)) {
    yield {
      pageId: page.pageId,
      pageNumber: page.pageNumber,
      ...range,
      snippet: makeSearchSnippet(index.text, range.index, range.end),
    };
  }
}

/** Range-only iterator for callers that need to count many matches without
 * allocating a snippet object for every occurrence. */
export function* iterateSearchRanges(
  index: SearchTextIndex,
  query: CompiledSearchQuery,
): Generator<SearchSourceRange> {
  if (!query.folded) return;
  let from = 0;
  while (from < index.folded.length) {
    const foldedStart = index.folded.indexOf(query.folded, from);
    if (foldedStart === -1) return;
    const foldedEnd = foldedStart + query.folded.length;
    if (
      !isValidFoldedBoundary(index, foldedStart) ||
      !isValidFoldedBoundary(index, foldedEnd)
    ) {
      from = foldedStart + 1;
      continue;
    }
    const start = sourceRangeAt(index, foldedStart).start;
    const end = sourceRangeAt(index, foldedEnd - 1).end;
    yield { index: start, end };
    from = foldedStart + Math.max(1, query.folded.length);
  }
}

function sourceRangeAt(
  index: SearchTextIndex,
  foldedOffset: number,
): { start: number; end: number } {
  const exceptions = index.mappingExceptions;
  let low = 0;
  let high = exceptions.length - 1;
  let nearest: SearchMappingException | null = null;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const candidate = exceptions[middle]!;
    if (candidate.foldedStart <= foldedOffset) {
      nearest = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (nearest && foldedOffset < nearest.foldedEnd) {
    return { start: nearest.sourceStart, end: nearest.sourceEnd };
  }
  const delta = nearest?.deltaAfter ?? 0;
  return {
    start: foldedOffset + delta,
    end: foldedOffset + delta + 1,
  };
}

function deterministicCaseFold(character: string): string {
  // Apply compatibility decomposition plus the pinned Unicode default full
  // case fold to an entire normalization cluster, then recompose. PDF fonts
  // frequently expose CJK compatibility ideographs/radicals or fullwidth
  // forms while users type their ordinary equivalents. Whole-cluster source
  // mapping still prevents a match from returning half a ligature/grapheme.
  let folded = "";
  for (const codePoint of character.normalize("NFKD")) {
    folded += FULL_CASE_FOLD_OVERRIDES[codePoint] ?? codePoint.toLowerCase();
  }
  return folded.normalize("NFKC");
}

function assertSearchMappingWithinLimit(
  text: string,
  limit: number,
  ignoredRanges: readonly SearchIgnoredRange[] = [],
): void {
  let mappings = 0;
  let sawVisible = false;
  let whitespaceStart: number | null = null;
  let whitespaceEnd = 0;
  let ignoredIndex = 0;
  for (const { segment, start, end } of searchClusters(text)) {
    while (
      ignoredIndex < ignoredRanges.length &&
      ignoredRanges[ignoredIndex]!.end <= start
    ) {
      ignoredIndex += 1;
    }
    const ignored = ignoredRanges[ignoredIndex];
    if (ignored && ignored.start <= start) {
      if (end > ignored.end) throw invalidIgnoredRange(ignored);
      if (start === ignored.start) mappings += 1;
      if (mappings > limit) throw mappingLimitError(limit);
      continue;
    }
    if (ignored && ignored.start < end) throw invalidIgnoredRange(ignored);
    const whitespace = /^\s+$/u.test(segment);
    if (whitespace) {
      whitespaceStart ??= start;
      whitespaceEnd = end;
    } else {
      if (
        whitespaceStart !== null &&
        (!sawVisible || whitespaceEnd - whitespaceStart !== 1)
      ) {
        mappings += 1;
      }
      whitespaceStart = null;
      sawVisible = true;
      const foldedSegment = deterministicCaseFold(segment);
      if (
        foldedSegment.length !== end - start ||
        requiresWholeClusterMapping(segment, foldedSegment)
      ) {
        mappings += 1;
      }
    }
    if (mappings > limit) {
      throw mappingLimitError(limit);
    }
  }
}

function normalizeIgnoredRanges(
  text: string,
  ranges: readonly SearchIgnoredRange[],
): SearchIgnoredRange[] {
  const sorted = ranges.map((range) => {
    if (
      !Number.isSafeInteger(range.start) ||
      !Number.isSafeInteger(range.end) ||
      range.start < 0 ||
      range.end <= range.start ||
      range.end > text.length
    ) {
      throw invalidIgnoredRange(range);
    }
    return { start: range.start, end: range.end };
  }).sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: SearchIgnoredRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push(range);
    }
  }
  return merged;
}

function invalidIgnoredRange(range: SearchIgnoredRange): SearchTextLimitError {
  return new SearchTextLimitError(
    `Ignored search range ${String(range.start)}-${String(range.end)} must cover complete in-bounds text clusters`,
  );
}

function mappingLimitError(limit: number): SearchTextLimitError {
  return new SearchTextLimitError(
    `Search text exceeds the remaining ${limit} normalization mapping budget`,
  );
}

function requiresWholeClusterMapping(
  sourceCluster: string,
  foldedCluster: string,
): boolean {
  if (foldedCluster.length !== sourceCluster.length) return false;
  // Canonical normalization can reorder equal-length combining marks. Those
  // output offsets are not linearly related to the source UTF-16 positions,
  // so expose only the whole grapheme cluster rather than a wrong subrange.
  return (
    Array.from(sourceCluster).length > 1 &&
    sourceCluster.normalize("NFKD") !== sourceCluster
  );
}

function isValidFoldedBoundary(index: SearchTextIndex, offset: number): boolean {
  if (offset <= 0 || offset >= index.folded.length) return true;
  const exceptions = index.mappingExceptions;
  let low = 0;
  let high = exceptions.length - 1;
  let nearest: SearchMappingException | null = null;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const candidate = exceptions[middle]!;
    if (candidate.foldedStart < offset) {
      nearest = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return !nearest || offset >= nearest.foldedEnd;
}

type SearchCluster = { segment: string; start: number; end: number };

const SEARCH_SEGMENTER =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter("und", { granularity: "grapheme" })
    : null;

function* searchClusters(text: string): Generator<SearchCluster> {
  if (SEARCH_SEGMENTER) {
    for (const part of SEARCH_SEGMENTER.segment(text)) {
      yield {
        segment: part.segment,
        start: part.index,
        end: part.index + part.segment.length,
      };
    }
    return;
  }
  // Conservative fallback for old WebViews without Intl.Segmenter: keep a
  // base plus combining/variation/ZWJ continuation code points together.
  for (let start = 0; start < text.length; ) {
    let end = nextCodePointEnd(text, start);
    let previousWasJoiner = false;
    while (end < text.length) {
      const nextEnd = nextCodePointEnd(text, end);
      const next = text.slice(end, nextEnd);
      const continuation =
        /\p{Mark}/u.test(next) ||
        next === "\u200d" ||
        previousWasJoiner ||
        isVariationOrEmojiModifier(next);
      if (!continuation) break;
      previousWasJoiner = next === "\u200d";
      end = nextEnd;
    }
    yield { segment: text.slice(start, end), start, end };
    start = end;
  }
}

function nextCodePointEnd(text: string, start: number): number {
  const codePoint = text.codePointAt(start);
  return start + (codePoint != null && codePoint > 0xffff ? 2 : 1);
}

function isVariationOrEmojiModifier(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? -1;
  return (
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef) ||
    (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff)
  );
}

function safeMappingBudget(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, fallback)
    : fallback;
}

export function makeSearchSnippet(
  text: string,
  index: number,
  matchEnd: number,
): SearchSnippet {
  const start = wordBoundaryStart(text, Math.max(0, index - SNIPPET_CONTEXT), index);
  const end = wordBoundaryEnd(
    text,
    Math.min(text.length, matchEnd + SNIPPET_CONTEXT),
    matchEnd,
  );
  return {
    before: `${start > 0 ? "…" : ""}${text.slice(start, index).trimStart()}`,
    match: text.slice(index, matchEnd),
    after: `${text.slice(matchEnd, end).trimEnd()}${end < text.length ? "…" : ""}`,
  };
}

function wordBoundaryStart(text: string, start: number, matchStart: number): number {
  if (start <= 0 || isBoundary(text, start)) return start;
  // Never scan outside the already-bounded snippet context. A long unbroken
  // word with many matches must stay O(matches * SNIPPET_CONTEXT), not O(n²).
  for (let index = start + 1; index <= matchStart; index += 1) {
    if (isBoundary(text, index)) return index;
  }
  return start;
}

function wordBoundaryEnd(text: string, end: number, matchEnd: number): number {
  if (end >= text.length || isBoundary(text, end)) return end;
  for (let index = end - 1; index >= matchEnd; index -= 1) {
    if (isBoundary(text, index)) return index;
  }
  return end;
}

function isBoundary(text: string, index: number): boolean {
  return index <= 0 || index >= text.length || /\s/.test(text[index - 1] ?? "");
}
