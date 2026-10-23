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
    // A consonant, a linker and another consonant form one conjunct
    // (UAX #29 GB9c): 0 off, 1 after a consonant, 2 after its linker.
    let conjunct = CONJUNCT_CONSONANT.test(text.slice(start, end)) ? 1 : 0;
    // Hangul jamo build one syllable (GB6-GB8): the last code point's kind.
    let hangul = hangulKind(text.slice(start, end));
    while (end < text.length) {
      const nextEnd = nextCodePointEnd(text, end);
      const next = text.slice(end, nextEnd);
      const linksConsonant = conjunct === 2 && CONJUNCT_CONSONANT.test(next);
      const nextHangul = hangulKind(next);
      const continuation =
        isFallbackContinuation(next) ||
        previousWasJoiner ||
        linksConsonant ||
        (hangul !== null && nextHangul !== null && HANGUL_FOLLOWERS[hangul].includes(nextHangul)) ||
        (unpairedIndicator && isRegionalIndicator(next));
      if (!continuation) break;
      hangul = nextHangul;
      if (linksConsonant) conjunct = 1;
      else if (conjunct && CONJUNCT_LINKER.test(next)) conjunct = 2;
      else if (!/^[\p{Mn}\p{Me}\u200d]$/u.test(next)) conjunct = 0;
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
    // ZWNJ extends a grapheme, as in Persian, though it breaks a conjunct.
    character === "\u200c" ||
    // Thai and Lao SARA AM: spacing marks that are letters by category.
    character === "\u0e33" ||
    character === "\u0eb3" ||
    isVariationOrEmojiModifier(character)
  );
}

// Indic_Conjunct_Break=Linker and =Consonant, read off Intl.Segmenter by
// probing "क" + L + "क" and "क्" + C for one grapheme (bun 1.4, ICU 78,
// Unicode 17); probe again, and extend searchClusters.test.ts, when a later
// Unicode adds to either property.
const CONJUNCT_LINKER =
  /^[्্્୍్്္្᩠᭄᮫꧀꫶\u{10A3F}\u{11133}\u{113D0}\u{1193E}\u{11A47}\u{11A99}\u{11F42}]$/u;
const CONJUNCT_CONSONANT =
  /^[क-हक़-य़ॸ-ॿক-নপ-রলশ-হড়ঢ়য়ৰৱક-નપ-રલળવ-હૹକ-ନପ-ରଲଳଵ-ହଡ଼ଢ଼ୟୱక-నప-హౘ-ౚക-ഺက-ဪဿၐ-ၕၚ-ၝၡၥၦၮ-ၰၵ-ႁႎក-ឳᨠ-ᩔᬋᬌᬓ-ᬳᭅ-ᭌᮃ-ᮠᮮᮯᮻ-ᮽꦉ-ꦋꦏ-ꦲꧠ-ꧤꧧ-ꧯꧺ-ꧾꩠ-ꩯꩱ-ꩳꩺꩾꩿꫠ-ꫪꯀ-ꯚ\u{10A00}\u{10A10}-\u{10A13}\u{10A15}-\u{10A17}\u{10A19}-\u{10A35}\u{11103}-\u{11126}\u{11144}\u{11147}\u{11380}-\u{11389}\u{1138B}\u{1138E}\u{11390}-\u{113B5}\u{11900}-\u{11906}\u{11909}\u{1190C}-\u{11913}\u{11915}\u{11916}\u{11918}-\u{1192F}\u{11A00}\u{11A0B}-\u{11A32}\u{11A50}\u{11A5C}-\u{11A83}\u{11F04}-\u{11F10}\u{11F12}-\u{11F33}]$/u;

type HangulKind = "L" | "V" | "T" | "LV" | "LVT";

/** What may follow each kind inside one syllable (UAX #29 GB6, GB7, GB8). */
const HANGUL_FOLLOWERS: Record<HangulKind, readonly HangulKind[]> = {
  L: ["L", "V", "LV", "LVT"],
  V: ["V", "T"],
  LV: ["V", "T"],
  T: ["T"],
  LVT: ["T"],
};

/** Hangul_Syllable_Type: leading, vowel and trailing jamo, and precomposed syllables. */
function hangulKind(character: string): HangulKind | null {
  const codePoint = character.codePointAt(0) ?? -1;
  if ((codePoint >= 0x1100 && codePoint <= 0x115f) || (codePoint >= 0xa960 && codePoint <= 0xa97c)) return "L";
  if ((codePoint >= 0x1160 && codePoint <= 0x11a7) || (codePoint >= 0xd7b0 && codePoint <= 0xd7c6)) return "V";
  if ((codePoint >= 0x11a8 && codePoint <= 0x11ff) || (codePoint >= 0xd7cb && codePoint <= 0xd7fb)) return "T";
  if (codePoint >= 0xac00 && codePoint <= 0xd7a3) return (codePoint - 0xac00) % 28 === 0 ? "LV" : "LVT";
  return null;
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
