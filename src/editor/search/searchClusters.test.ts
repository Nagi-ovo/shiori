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
    ]) {
      expect(segments(fallbackSearchClusters(text))).toEqual(
        segments(segmenter.segment(text)),
      );
    }
  });
});
