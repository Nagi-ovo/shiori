const graphemeSegmenter =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter("und", { granularity: "grapheme" })
    : null;

function codePoint(value: string): number {
  return value.codePointAt(0) ?? 0;
}

function isRegionalIndicator(value: string): boolean {
  const point = codePoint(value);
  return point >= 0x1f1e6 && point <= 0x1f1ff;
}

function isEmojiModifier(value: string): boolean {
  const point = codePoint(value);
  return point >= 0x1f3fb && point <= 0x1f3ff;
}

function isVariationOrTag(value: string): boolean {
  const point = codePoint(value);
  return (
    (point >= 0xfe00 && point <= 0xfe0f) ||
    (point >= 0xe0100 && point <= 0xe01ef) ||
    (point >= 0xe0020 && point <= 0xe007f)
  );
}

// UAX #29 GB9c keeps a virama/consonant linker and the following consonant in
// one grapheme. This compact list covers the scripts Shiori treats as common
// complex text while Intl.Segmenter remains the full modern implementation.
const VIRAMA_CODE_POINTS = new Set([
  0x094d, // Devanagari
  0x09cd, // Bengali
  0x0a4d, // Gurmukhi
  0x0acd, // Gujarati
  0x0b4d, // Oriya
  0x0bcd, // Tamil
  0x0c4d, // Telugu
  0x0ccd, // Kannada
  0x0d4d, // Malayalam
  0x0dca, // Sinhala
  0x0f84, // Tibetan
  0x1039, // Myanmar virama
  0x103a, // Myanmar asat
  0x1714, // Tagalog
  0x1734, // Hanunoo
  0x17d2, // Khmer coeng
  0x1a60, // Tai Tham sign sakot
  0x1b44, // Balinese adeg adeg
  0xa806, // Syloti Nagri hasanta
  0xa8c4, // Saurashtra virama
  0xa953, // Rejang virama
  0xa9c0, // Javanese pangkon
  0xaaf6, // Meetei Mayek virama
  0xabed, // Meetei Mayek apun iyek
]);

function isVirama(value: string): boolean {
  return VIRAMA_CODE_POINTS.has(codePoint(value));
}

function isHangulL(point: number): boolean {
  return (
    (point >= 0x1100 && point <= 0x115f) ||
    (point >= 0xa960 && point <= 0xa97c)
  );
}

function isHangulV(point: number): boolean {
  return (
    (point >= 0x1160 && point <= 0x11a7) ||
    (point >= 0xd7b0 && point <= 0xd7c6)
  );
}

function isHangulT(point: number): boolean {
  return (
    (point >= 0x11a8 && point <= 0x11ff) ||
    (point >= 0xd7cb && point <= 0xd7fb)
  );
}

function hangulSyllableKind(point: number): "lv" | "lvt" | null {
  if (point < 0xac00 || point > 0xd7a3) return null;
  return (point - 0xac00) % 28 === 0 ? "lv" : "lvt";
}

function shouldJoinHangul(previous: string, current: string): boolean {
  const previousPoint = codePoint(previous);
  const currentPoint = codePoint(current);
  const previousSyllable = hangulSyllableKind(previousPoint);
  return (
    (isHangulL(previousPoint) &&
      (isHangulL(currentPoint) ||
        isHangulV(currentPoint) ||
        hangulSyllableKind(currentPoint) !== null)) ||
    ((isHangulV(previousPoint) || previousSyllable === "lv") &&
      (isHangulV(currentPoint) || isHangulT(currentPoint))) ||
    ((isHangulT(previousPoint) || previousSyllable === "lvt") &&
      isHangulT(currentPoint))
  );
}

/** Conservative dependency-free fallback for older WebViews. */
export function splitGraphemesFallback(text: string): string[] {
  const result: string[] = [];
  let regionalRun = 0;
  for (const current of Array.from(text)) {
    const previousCluster = result.at(-1);
    if (previousCluster === undefined) {
      result.push(current);
      regionalRun = isRegionalIndicator(current) ? 1 : 0;
      continue;
    }

    const previous = Array.from(previousCluster).at(-1) ?? "";
    const continuation =
      /\p{M}/u.test(current) ||
      isVariationOrTag(current) ||
      isEmojiModifier(current);
    const joinsPrevious =
      continuation ||
      current === "\u200d" ||
      previous === "\u200d" ||
      (isVirama(previous) && /\p{L}/u.test(current)) ||
      (previous === "\r" && current === "\n") ||
      shouldJoinHangul(previous, current);

    if (isRegionalIndicator(current)) {
      if (regionalRun % 2 === 1) {
        result[result.length - 1] += current;
      } else {
        result.push(current);
      }
      regionalRun += 1;
    } else if (joinsPrevious) {
      result[result.length - 1] += current;
      regionalRun = 0;
    } else {
      result.push(current);
      regionalRun = 0;
    }
  }
  return result;
}

export function splitGraphemes(text: string): string[] {
  if (graphemeSegmenter) {
    return Array.from(graphemeSegmenter.segment(text), (part) => part.segment);
  }
  return splitGraphemesFallback(text);
}
