import { describe, expect, test } from "bun:test";
import {
  MAX_DOCUMENT_SEARCH_MAPPING_EXCEPTIONS,
  MAX_FIND_MATCHES,
  MAX_SEARCH_MAPPING_EXCEPTIONS,
  SearchTextLimitError,
  buildSearchTextIndex,
  compileSearchQuery,
  findMatches,
  findMatchesWithStatus,
  indexSearchPages,
  iterateSearchRanges,
} from "./findMatches";

describe("find matches", () => {
  test("finds case-insensitive matches across document-order pages", () => {
    expect(
      findMatches(
        [
          { pageId: "b", pageNumber: 1, text: "Beta starts here. beta ends." },
          { pageId: "a", pageNumber: 2, text: "No match." },
        ],
        " beta ",
      ).map((m) => ({ pageId: m.pageId, pageNumber: m.pageNumber, index: m.index })),
    ).toEqual([
      { pageId: "b", pageNumber: 1, index: 0 },
      { pageId: "b", pageNumber: 1, index: 18 },
    ]);
  });

  test("returns no matches for empty queries", () => {
    expect(
      findMatches([{ pageId: "p", pageNumber: 1, text: "anything" }], " "),
    ).toEqual([]);
  });

  test("returns structured snippets with the match separated", () => {
    const [match] = findMatches(
      [{ pageId: "p", pageNumber: 1, text: "Alpha Joint Embedding Beta" }],
      "joint",
    );
    expect(match?.snippet).toEqual({
      before: "Alpha ",
      match: "Joint",
      after: " Embedding Beta",
    });
  });

  test("clips snippets at word boundaries", () => {
    const text = `${"x".repeat(48)} Brown University Joint Embedding ${"y".repeat(48)}`;
    const [match] = findMatches([{ pageId: "p", pageNumber: 1, text }], "Joint");
    expect(match?.snippet.before.startsWith("…Brown")).toBe(true);
    expect(match?.snippet.after.endsWith("Embedding…")).toBe(true);
  });

  test("folds query and document whitespace through the same index", () => {
    const [match] = findMatches(
      [{ pageId: "p", pageNumber: 1, text: "alpha\n\t  beta" }],
      " alpha   \n beta ",
    );
    expect(match).toMatchObject({ index: 0, end: 13 });
    expect(match?.snippet.match).toBe("alpha\n\t  beta");
  });

  test("maps matches through ignored layout-only ranges", () => {
    const singleIgnoredRange = buildSearchTextIndex("跨 行", undefined, [
      { start: 1, end: 2 },
    ]);
    expect(singleIgnoredRange.mappingExceptions).toHaveLength(1);

    const source = "跨 行 inter- national";
    const joined = buildSearchTextIndex(source, undefined, [
      { start: 1, end: 2 },
      { start: 9, end: 11 },
    ]);
    expect(
      Array.from(iterateSearchRanges(joined, compileSearchQuery("跨行"))),
    ).toEqual([{ index: 0, end: 3 }]);
    expect(
      Array.from(
        iterateSearchRanges(joined, compileSearchQuery("international")),
      ),
    ).toEqual([{ index: 4, end: source.length }]);
  });

  test("maps lowercase expansions back to the original text range", () => {
    const [match] = findMatches(
      [{ pageId: "p", pageNumber: 1, text: "İABC" }],
      "ABC",
    );
    expect(match).toMatchObject({ index: 1, end: 4 });
    expect(match?.snippet.match).toBe("ABC");

    const [afterLeadingSpace] = findMatches(
      [{ pageId: "p", pageNumber: 1, text: "  İABC  " }],
      "ABC",
    );
    expect(afterLeadingSpace).toMatchObject({ index: 3, end: 6 });
  });

  test("applies full Unicode folding and maps NFC/NFD to whole source ranges", () => {
    const [greek] = findMatches(
      [{ pageId: "p", pageNumber: 1, text: "ΟΣ" }],
      "ος",
    );
    expect(greek).toMatchObject({ index: 0, end: 2 });

    const [sharpS] = findMatches(
      [{ pageId: "p", pageNumber: 1, text: "Straße" }],
      "STRASSE",
    );
    expect(sharpS?.snippet.match).toBe("Straße");

    const decomposed = "Cafe\u0301";
    const [accent] = findMatches(
      [{ pageId: "p", pageNumber: 1, text: decomposed }],
      "Café",
    );
    expect(accent).toMatchObject({ index: 0, end: decomposed.length });
    expect(
      findMatches([{ pageId: "p", pageNumber: 1, text: "é" }], "e"),
    ).toEqual([]);

    const [ligature] = findMatches(
      [{ pageId: "p", pageNumber: 1, text: "oﬃce" }],
      "office",
    );
    expect(ligature?.snippet.match).toBe("oﬃce");

    const [wholeSharpS] = findMatches(
      [{ pageId: "p", pageNumber: 1, text: "ß" }],
      "ss",
    );
    expect(wholeSharpS?.snippet.match).toBe("ß");
    expect(findMatches([{ pageId: "p", pageNumber: 1, text: "ß" }], "s")).toEqual(
      [],
    );
  });

  test("matches PDF compatibility CJK, fullwidth forms, and ligatures", () => {
    const source = "Token ⾃由 同时⾼强度使⽤ ＡＢＣ oﬃce";
    const [cjk] = findMatches(
      [{ pageId: "p", pageNumber: 1, text: source }],
      "Token 自由 同时高强度使用",
    );
    expect(cjk?.snippet.match).toBe("Token ⾃由 同时⾼强度使⽤");
    expect(
      findMatches([{ pageId: "p", pageNumber: 1, text: source }], "abc"),
    ).toHaveLength(1);
    expect(
      findMatches([{ pageId: "p", pageNumber: 1, text: source }], "office"),
    ).toHaveLength(1);
  });

  test("never maps canonically reordered marks to the wrong source code point", () => {
    const source = "x\u0315\u0300";
    const [whole] = findMatches(
      [{ pageId: "p", pageNumber: 1, text: source }],
      "x\u0300\u0315",
    );
    expect(whole).toMatchObject({ index: 0, end: source.length });
    expect(
      findMatches([{ pageId: "p", pageNumber: 1, text: source }], "\u0300"),
    ).toEqual([]);
    expect(
      findMatches([{ pageId: "p", pageNumber: 1, text: source }], "\u0315"),
    ).toEqual([]);
  });

  test("never returns half of an astral Unicode character", () => {
    const [emoji] = findMatches(
      [{ pageId: "p", pageNumber: 1, text: "before 😀 after" }],
      "😀",
    );
    expect(emoji).toMatchObject({ index: 7, end: 9 });
    expect(emoji?.snippet.match).toBe("😀");
    expect(
      findMatches(
        [{ pageId: "p", pageNumber: 1, text: "before 😀 after" }],
        "\ud83d",
      ),
    ).toEqual([]);
  });

  test("never returns half of an emoji or diacritic grapheme", () => {
    const ranges = (text: string, query: string) =>
      findMatches([{ pageId: "p", pageNumber: 1, text }], query).map((m) => [m.index, m.end]);
    // A skin-tone modifier, and a mark NFKC has no precomposed form for.
    expect(ranges("👍🏽x", "👍")).toEqual([]);
    expect(ranges("👍🏽x", "👍🏽")).toEqual([[0, 4]]);
    expect(ranges("q\u0301x", "q")).toEqual([]);
    expect(ranges("q\u0301x", "q\u0301")).toEqual([[0, 2]]);
    // Indic vowel signs and viramas stay addressable, so a word's prefix
    // still finds it.
    expect(ranges("हिन्दी", "हिन्द")).toEqual([[0, 5]]);
  });

  test("caps repetitive results and keeps snippet work bounded", () => {
    const result = findMatchesWithStatus(
      [{ pageId: "p", pageNumber: 1, text: "a".repeat(MAX_FIND_MATCHES * 2) }],
      "a",
    );
    const matches = result.matches;
    expect(matches).toHaveLength(MAX_FIND_MATCHES);
    expect(result.truncated).toBe(true);
    expect(matches.at(-1)).toMatchObject({
      index: MAX_FIND_MATCHES - 1,
      end: MAX_FIND_MATCHES,
    });
  });

  test("bounds pathological normalization maps without rejecting normal spaces", () => {
    expect(
      buildSearchTextIndex("a ".repeat(MAX_SEARCH_MAPPING_EXCEPTIONS + 1))
        .mappingExceptions,
    ).toHaveLength(0);
    expect(() =>
      buildSearchTextIndex("İ".repeat(MAX_SEARCH_MAPPING_EXCEPTIONS + 1)),
    ).toThrow(SearchTextLimitError);
  });

  test("bounds normalization mappings retained across the whole document", () => {
    expect(() =>
      indexSearchPages(
        [
          { pageId: "p1", pageNumber: 1, text: "İİ" },
          { pageId: "p2", pageNumber: 2, text: "İİ" },
          { pageId: "p3", pageNumber: 3, text: "İ" },
        ],
        { maxMappingExceptions: 4 },
      ),
    ).toThrow(SearchTextLimitError);
    expect(MAX_DOCUMENT_SEARCH_MAPPING_EXCEPTIONS).toBeGreaterThan(
      MAX_SEARCH_MAPPING_EXCEPTIONS,
    );
    expect(() =>
      buildSearchTextIndex(
        "İ".repeat(MAX_SEARCH_MAPPING_EXCEPTIONS + 1),
        Number.MAX_SAFE_INTEGER,
      ),
    ).toThrow(SearchTextLimitError);
  });
});
