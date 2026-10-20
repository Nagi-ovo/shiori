import {
  MAX_DOCUMENT_SEARCH_MAPPING_EXCEPTIONS,
  MAX_SEARCH_MAPPING_EXCEPTIONS,
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
// cross. App Find, CLI search and quote anchors all match through here, so
// they agree on what a page contains.

export type LayoutSearchPageText = SearchPageText & {
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

/** indexSearchPages for layout-aware pages, under one document-wide
 * normalization mapping budget. */
export function indexLayoutSearchPages(
  pages: readonly LayoutSearchPageText[],
): LayoutIndexedSearchPage[] {
  let remainingMappings = MAX_DOCUMENT_SEARCH_MAPPING_EXCEPTIONS;
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
      alternateIndexes: [],
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
