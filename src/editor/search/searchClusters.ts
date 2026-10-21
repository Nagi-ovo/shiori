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
