import type { SemanticLayoutBreak } from "../textSelection/semanticText";
import {
  MAX_DOCUMENT_SEARCH_MAPPING_EXCEPTIONS,
  MAX_SEARCH_MAPPING_EXCEPTIONS,
  SearchTextLimitError,
  buildSearchTextIndex,
  findMatchesInSearchIndexes,
  iterateSearchRanges,
  type CompiledSearchQuery,
  type FindMatchesResult,
  type IndexedSearchPage,
  type SearchIgnoredRange,
  type SearchPageText,
  type SearchSourceRange,
  type SearchTextIndex,
} from "./findMatches";

// Search over page text that knows its layout: the separators the semantic
// text puts at paragraph and column ends (`hardBreaks`), which no match may
// cross, and those at soft line wraps (`layoutBreaks`), which a match may
// skip, along with a wrap hyphen. App Find, CLI search and quote anchors all
// match through here, so they agree on what a page contains.

export type LayoutSearchPageText = SearchPageText & {
  layoutBreaks?: readonly SemanticLayoutBreak[];
  hardBreaks?: readonly SearchIgnoredRange[];
};

export type LayoutIndexedSearchPage = IndexedSearchPage & {
  /** Other projections of the same text, searched alongside `index`. */
  alternateIndexes: SearchTextIndex[];
  hardBreaks: readonly SearchIgnoredRange[];
};

/** Search every index of a page in source order, never returning the same
 * source range twice and dropping ranges that cross a hard break. */
export function* iterateLayoutSearchRanges(
  indexes: readonly SearchTextIndex[],
  hardBreaks: readonly SearchIgnoredRange[],
  query: CompiledSearchQuery,
): Generator<SearchSourceRange> {
  const iterators = indexes.map((index) => iterateSearchRanges(index, query));
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
    const crossesHardBreak = rangeIntersectsSortedBreaks(selected, hardBreaks);
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
  hardBreaks: readonly SearchIgnoredRange[],
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

/** The page text with its soft wraps removed (and, where a wrap follows a
 * hyphen, with the hyphen removed too), when that reads differently from
 * `normal`. Ranges found in them still address the original text. With a
 * `budget`, each index draws its normalization mappings from it. */
export function buildLayoutSearchIndexes(
  index: { text: string; layoutBreaks: readonly SemanticLayoutBreak[] },
  normal: SearchTextIndex,
  budget?: { remaining: number },
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
  const add = (ignoredRanges: SearchIgnoredRange[]) => {
    const candidate = buildSearchTextIndex(
      index.text,
      budget ? Math.min(MAX_SEARCH_MAPPING_EXCEPTIONS, budget.remaining) : undefined,
      ignoredRanges,
    );
    if (budget) budget.remaining -= candidate.mappingExceptions.length;
    if (
      candidate.folded !== normal.folded &&
      !output.some((existing) => existing.folded === candidate.folded)
    ) {
      output.push(candidate);
    }
  };
  add(joinedRanges);
  if (
    dehyphenatedRanges.some(
      (range, rangeIndex) => range.start !== joinedRanges[rangeIndex]!.start,
    )
  ) {
    add(dehyphenatedRanges);
  }
  return output;
}

/** indexSearchPages for layout-aware pages, under one document-wide
 * normalization mapping budget. The wrap-free projections draw from a
 * budget of their own: once a long document spends it, later pages are
 * searched without them rather than the whole index failing. */
export function indexLayoutSearchPages(
  pages: readonly LayoutSearchPageText[],
): LayoutIndexedSearchPage[] {
  let remainingMappings = MAX_DOCUMENT_SEARCH_MAPPING_EXCEPTIONS;
  const layoutBudget = { remaining: MAX_DOCUMENT_SEARCH_MAPPING_EXCEPTIONS };
  return pages.map((page) => {
    const index = buildSearchTextIndex(
      page.text,
      Math.min(MAX_SEARCH_MAPPING_EXCEPTIONS, remainingMappings),
    );
    remainingMappings -= index.mappingExceptions.length;
    let alternateIndexes: SearchTextIndex[] = [];
    try {
      alternateIndexes = buildLayoutSearchIndexes(
        { text: page.text, layoutBreaks: page.layoutBreaks ?? [] },
        index,
        layoutBudget,
      );
    } catch (error) {
      if (!(error instanceof SearchTextLimitError)) throw error;
      layoutBudget.remaining = 0;
    }
    return {
      pageId: page.pageId,
      pageNumber: page.pageNumber,
      index,
      alternateIndexes,
      hardBreaks: page.hardBreaks ?? [],
    };
  });
}

export function findLayoutSearchMatches(
  pages: readonly LayoutIndexedSearchPage[],
  rawQuery: string,
): FindMatchesResult {
  return findMatchesInSearchIndexes(pages, rawQuery, (page, query) =>
    iterateLayoutSearchRanges(
      [page.index, ...page.alternateIndexes],
      page.hardBreaks,
      query,
    ),
  );
}
