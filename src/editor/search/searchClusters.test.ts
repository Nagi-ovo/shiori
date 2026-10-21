import { describe, expect, test } from "bun:test";
import { fallbackSearchClusters } from "./searchClusters";

const segments = (clusters: Iterable<{ segment: string }>) =>
  Array.from(clusters, (cluster) => cluster.segment);

describe("search clusters without Intl.Segmenter", () => {
  test("keep each emoji sequence and grapheme whole, as Intl.Segmenter does", () => {
    const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
    for (const text of [
      "🇬🇧x", // a flag: two regional indicators
      "🇬🇧🇫🇷🇩", // flags pair off; an odd one stands alone
      "🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}x", // a tag sequence flag
      "👍🏽x",
      "👨‍👩‍👧y",
      "1️⃣a",
      "éz",
      "ทำx", // Thai SARA AM: a spacing mark whose category is a letter
      // Conjuncts: a virama links two consonants into one grapheme...
      "क्षx",
      "क़्‍षx", // ...through a nukta and a ZWJ,
      "ক্ষx",
      "ക്ഷx",
      "ស្រីx", // a Khmer coeng,
      "က္ကx", // a Myanmar virama;
      "क्‌षx", // ...but not through a ZWNJ,
      "अ्षx", // from a vowel,
      "का्षx", // past a vowel sign,
      "க்ஷx", // or with a Tamil pulli, which is no linker.
      // Hangul jamo join into syllables (UAX #29 GB6-GB8): L V T,
      "\u1100\u1161\u11a8x",
      "\u1100\u1100\u1161x", // L L V,
      "\u1100\uac00\u11a8x", // L, a precomposed LV and a T,
      "\uac01\u11a8\u11a8x", // LVT T T,
      "\ua960\ud7b0\ud7cbx", // the extended jamo blocks;
      "\uac01\u1161x", // but no V after a T or an LVT,
      "\u11a8\u1100x", // no L after a T,
      "\u1100\u0301\u1161x", // and no join across a mark.
    ]) {
      expect(segments(fallbackSearchClusters(text))).toEqual(
        segments(segmenter.segment(text)),
      );
    }
  });
});
