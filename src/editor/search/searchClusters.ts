// Grapheme clusters for search: the unit a match may start or end on.
// Split out of findMatches.ts, which consumes them.

export type SearchCluster = { segment: string; start: number; end: number };

const SEARCH_SEGMENTER =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter("und", { granularity: "grapheme" })
    : null;

export function* searchClusters(text: string): Generator<SearchCluster> {
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
  yield* fallbackSearchClusters(text);
}

/** Code units between the cluster starts an index keeps for the locator. */
export const CLUSTER_START_STRIDE = 128;

/** Locate clusters lazily, as searchClusters(text) splits them, so search
 * can snap a match to whole graphemes without storing every boundary.
 * `clusterStarts` is a sorted, sparse list of true cluster starts, the first
 * at 0; text between two of them segments the same as the whole text.
 * (Intl.Segments.containing would do, but JavaScriptCore answers it wrongly
 * at an astral cluster's first code unit.) */
export function searchClusterLocator(
  text: string,
  clusterStarts: readonly number[],
): {
  /** Start of the cluster `offset` is in. */
  start(offset: number): number;
  /** `offset` itself on a boundary, else the end of the cluster it splits. */
  end(offset: number): number;
} {
  const containing = (offset: number): SearchCluster => {
    let low = 0;
    let high = clusterStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >>> 1;
      if (clusterStarts[middle]! <= offset) low = middle;
      else high = middle - 1;
    }
    const from = clusterStarts[low] ?? 0;
    const to = clusterStarts[low + 1] ?? text.length;
    for (const cluster of searchClusters(text.slice(from, to))) {
      if (from + cluster.end > offset) {
        return { ...cluster, start: from + cluster.start, end: from + cluster.end };
      }
    }
    return { segment: "", start: offset, end: offset };
  };
  const onBoundary = (offset: number) =>
    offset <= 0 ||
    offset >= text.length ||
    // Below U+0300 nothing extends or joins a cluster, bar CR LF.
    (text.charCodeAt(offset) < 0x300 &&
      text.charCodeAt(offset - 1) < 0x300 &&
      text.charCodeAt(offset - 1) !== 0x0d);
  return {
    start: (offset) => (onBoundary(offset) ? offset : containing(offset).start),
    end: (offset) => {
      if (onBoundary(offset)) return offset;
      const cluster = containing(offset);
      return cluster.start < offset ? cluster.end : offset;
    },
  };
}

/** Conservative fallback for old WebViews without Intl.Segmenter: keep a
 * base plus combining/variation/ZWJ continuation code points together. */
export function* fallbackSearchClusters(text: string): Generator<SearchCluster> {
  for (let start = 0; start < text.length; ) {
    let end = nextCodePointEnd(text, start);
    let previousWasJoiner = false;
    // A regional indicator pairs with the next one into a flag.
    let unpairedIndicator = isRegionalIndicator(text.slice(start, end));
    while (end < text.length) {
      const nextEnd = nextCodePointEnd(text, end);
      const next = text.slice(end, nextEnd);
      const continuation =
        isFallbackContinuation(next) ||
        previousWasJoiner ||
        (unpairedIndicator && isRegionalIndicator(next));
      if (!continuation) break;
      previousWasJoiner = next === "\u200d";
      unpairedIndicator = false;
      end = nextEnd;
    }
    yield { segment: text.slice(start, end), start, end };
    start = end;
  }
}

function isFallbackContinuation(character: string): boolean {
  return (
    /\p{Mark}/u.test(character) ||
    character === "\u200d" ||
    // Thai and Lao SARA AM: spacing marks that are letters by category.
    character === "\u0e33" ||
    character === "\u0eb3" ||
    isVariationOrEmojiModifier(character)
  );
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
    (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff) ||
    // Tag characters spelling a subdivision flag, and its cancel tag.
    (codePoint >= 0xe0020 && codePoint <= 0xe007f)
  );
}

function isRegionalIndicator(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? -1;
  return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
}
