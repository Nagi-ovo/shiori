import { describe, expect, test } from "bun:test";
import { fallbackSearchClusters } from "./searchClusters";

const segments = (clusters: Iterable<{ segment: string }>) =>
  Array.from(clusters, (cluster) => cluster.segment);

describe("search clusters without Intl.Segmenter", () => {
  test("keep each emoji sequence and grapheme whole, as Unicode 17 does", () => {
    // "|" marks each cluster boundary of UAX #29 in Unicode 17 (ICU 78
    // agrees). Spelled out rather than read from the runtime's own
    // Intl.Segmenter, whose answer follows the ICU it ships: ICU 74
    // (Unicode 15.1, bun 1.3.12 on Linux) splits a Khmer coeng.
    for (const marked of [
      "🇬🇧|x", // a flag: two regional indicators
      "🇬🇧|🇫🇷|🇩", // flags pair off; an odd one stands alone
      "🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}|x", // a tag sequence flag
      "👍🏽|x",
      "👨‍👩‍👧|y",
      "1️⃣|a",
      "é|z",
      "ทำ|x", // Thai SARA AM: a spacing mark whose category is a letter
      // Conjuncts: a virama links two consonants into one grapheme...
      "क्ष|x",
      "क़्‍ष|x", // ...through a nukta and a ZWJ,
      "ক্ষ|x",
      "ക്ഷ|x",
      "ស្រី|x", // a Khmer coeng,
      "က္က|x", // a Myanmar virama;
      "क्‌|ष|x", // ...but not through a ZWNJ,
      "अ्|ष|x", // from a vowel,
      "का्|ष|x", // past a vowel sign,
      "க்|ஷ|x", // or with a Tamil pulli, which is no linker.
      // Hangul jamo join into syllables (UAX #29 GB6-GB8): L V T,
      "\u1100\u1161\u11a8|x",
      "\u1100\u1100\u1161|x", // L L V,
      "\u1100\uac00\u11a8|x", // L, a precomposed LV and a T,
      "\uac01\u11a8\u11a8|x", // LVT T T,
      "\ua960\ud7b0\ud7cb|x", // the extended jamo blocks;
      "\uac01|\u1161|x", // but no V after a T or an LVT,
      "\u11a8|\u1100|x", // no L after a T,
      "\u1100\u0301|\u1161|x", // and no join across a mark.
    ]) {
      const clusters = marked.split("|");
      expect(segments(fallbackSearchClusters(clusters.join("")))).toEqual(
        clusters,
      );
    }
  });
});
