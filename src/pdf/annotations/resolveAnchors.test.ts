import { describe, expect, test } from "bun:test";
import type { TextContent } from "pdfjs-dist/types/src/display/api";
import type {
  Overlay,
  OverlayTextAnchor,
  PageModel,
} from "../model/types";
import {
  buildSearchTextIndex,
  compileSearchQuery,
  findMatches,
} from "../../editor/search/findMatches";
import { semanticTextContentToString } from "../../editor/textSelection/semanticText";
import { annotationSpecViolation } from "./spec";
import {
  AnchorResolutionError,
  AnchorTextUnavailableError,
  MAX_ANCHOR_INDEXED_TEXT_UNITS,
  MAX_ANCHOR_SEARCH_WORK,
  attachResolvedAnchors,
  buildAnchorPageText,
  iterateAnchorSearchRanges,
  resolveAnnotationSpecAnchors,
  specHasAnchors,
  type AnchorPageText,
} from "./resolveAnchors";

const page: PageModel = {
  id: "page-1",
  sourceIndex: 0,
  rotation: 0,
  originXPt: 0,
  originYPt: 0,
  widthPt: 612,
  heightPt: 792,
};

function item(str: string, x: number, y: number, width: number) {
  return {
    str,
    dir: "ltr",
    transform: [12, 0, 0, 12, x, y],
    width,
    height: 12,
    fontName: "f1",
    hasEOL: false,
  };
}

function content(items: unknown[]): TextContent {
  return {
    items,
    styles: {
      f1: { ascent: 0.75, descent: -0.25, fontFamily: "serif", vertical: false },
    },
  } as unknown as TextContent;
}

// Page 1: "The quick brown fox" / page 2: "quick again quick" on two lines.
const PAGE_TEXT: Record<number, TextContent> = {
  1: content([
    item("The", 72, 700, 24),
    item("quick", 100, 700, 30),
    item("brown", 134, 700, 36),
    item("fox", 174, 700, 18),
  ]),
  2: content([
    item("quick", 72, 700, 30),
    item("again", 106, 700, 30),
    item("quick", 72, 680, 30),
  ]),
};

function loader(pageNumber: number): Promise<AnchorPageText> {
  const textContent = PAGE_TEXT[pageNumber];
  if (!textContent) throw new Error(`no fixture page ${pageNumber}`);
  return Promise.resolve(buildAnchorPageText(pageNumber, textContent, page));
}

function anchoredSpec(anchor: Record<string, unknown>) {
  return { annotations: [{ type: "highlight", anchor }] };
}

describe("specHasAnchors", () => {
  test("detects anchors and ignores plain specs", () => {
    expect(specHasAnchors(anchoredSpec({ quote: "x" }))).toBe(true);
    expect(
      specHasAnchors({ annotations: [{ type: "highlight", rects: [] }] }),
    ).toBe(false);
    expect(specHasAnchors(null)).toBe(false);
  });
});

describe("resolveAnnotationSpecAnchors", () => {
  test("returns anchor-free specs as the same reference", async () => {
    const spec = { annotations: [{ type: "note", page: 1, at: { x: 1, y: 2 } }] };
    await expect(resolveAnnotationSpecAnchors(spec, 2, loader)).resolves.toBe(
      spec,
    );
  });

  test("resolves a unique quote to page, rects, and quote text", async () => {
    const resolved = (await resolveAnnotationSpecAnchors(
      anchoredSpec({ quote: "brown fox" }),
      2,
      loader,
    )) as { annotations: Array<Record<string, unknown>> };
    const annotation = resolved.annotations[0]!;
    expect(annotation.anchor).toBeUndefined();
    expect(annotation.page).toBe(1);
    expect(annotation.quote).toBe("brown fox");
    expect(annotation.rects).toEqual([{ x: 134, y: 697, w: 58, h: 12 }]);
    // The resolved output passes the shared violation rules.
    expect(annotationSpecViolation(resolved.annotations)).toBeNull();
  });

  test("normalizes copied line breaks and preserves Unicode source ranges", async () => {
    const multiline = content([
      { ...item("a filled first line", 72, 700, 96), hasEOL: true },
      item("second", 72, 680, 36),
    ]);
    const multilinePage = buildAnchorPageText(1, multiline, page);
    const byWhitespace = (await resolveAnnotationSpecAnchors(
      anchoredSpec({ quote: "line\n\t second" }),
      1,
      async () => multilinePage,
    )) as { annotations: Array<Record<string, unknown>> };
    expect(byWhitespace.annotations[0]!.quote).toBe("line second");
    expect(byWhitespace.annotations[0]!.rects).toHaveLength(2);

    const expanded = content([item("İABC", 100, 640, 40)]);
    const expandedPage = buildAnchorPageText(1, expanded, page);
    const byCaseFold = (await resolveAnnotationSpecAnchors(
      anchoredSpec({ quote: "ABC" }),
      1,
      async () => expandedPage,
    )) as { annotations: Array<Record<string, unknown>> };
    expect(byCaseFold.annotations[0]!.quote).toBe("ABC");
    expect(byCaseFold.annotations[0]!.rects).toEqual([
      { x: 110, y: 637, w: 30, h: 12 },
    ]);
  });

  test("shares visual-wrap, dehyphenation, and compatibility matching", async () => {
    const wrapped = content([
      { ...item("翻天覆地的", 72, 700, 60), hasEOL: true },
      { ...item("变化", 72, 686, 24), hasEOL: true },
      { ...item("极好。其对", 72, 672, 60), hasEOL: true },
      item("整体架构", 72, 658, 48),
      { ...item("inter-", 72, 630, 36), hasEOL: true },
      item("national", 72, 616, 48),
      item("Token ⾃由 同时⾼强度使⽤", 72, 590, 156),
    ]);
    const anchorPage = buildAnchorPageText(1, wrapped, page);
    for (const quote of [
      "翻天覆地的变化",
      "极好。其对整体架构",
      "international",
      "Token 自由 同时高强度使用",
    ]) {
      const resolved = (await resolveAnnotationSpecAnchors(
        anchoredSpec({ quote }),
        1,
        async () => anchorPage,
      )) as { annotations: Array<{ rects: unknown[] }> };
      expect(resolved.annotations[0]!.rects.length).toBeGreaterThan(0);
    }
  });

  test("does not match across a paragraph-sized visual gap", async () => {
    const paragraphs = content([
      { ...item("first paragraph", 72, 700, 84), hasEOL: true },
      item("second paragraph", 72, 660, 96),
    ]);
    const anchorPage = buildAnchorPageText(1, paragraphs, page);
    await expect(
      resolveAnnotationSpecAnchors(
        anchoredSpec({ quote: "paragraph second" }),
        1,
        async () => anchorPage,
      ),
    ).rejects.toThrow(/was not found/);
  });

  test("does not cross short paragraphs with ordinary line leading", async () => {
    const paragraphs = content([
      { ...item("short end", 72, 700, 42), hasEOL: true },
      item("next paragraph", 72, 686, 60),
    ]);
    const anchorPage = buildAnchorPageText(1, paragraphs, page);
    await expect(
      resolveAnnotationSpecAnchors(
        anchoredSpec({ quote: "end next" }),
        1,
        async () => anchorPage,
      ),
    ).rejects.toThrow(/was not found/);
  });

  test("checks many repeated matches against hard breaks logarithmically", () => {
    const matchCount = 4_096;
    const text = "x ".repeat(matchCount);
    const sourceBreaks = Array.from({ length: matchCount }, (_, index) => ({
      start: index * 2 + 1,
      end: index * 2 + 2,
    }));
    let indexedBreakReads = 0;
    const hardBreaks = new Proxy(sourceBreaks, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) {
          indexedBreakReads += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const matches = Array.from(
      iterateAnchorSearchRanges(
        {
          index: { text, spans: [], layoutBreaks: [], hardBreaks },
          searchIndex: buildSearchTextIndex(text),
          alternateSearchIndexes: [],
        },
        compileSearchQuery("x"),
      ),
    );

    expect(matches).toHaveLength(matchCount);
    // log2(4096) + the candidate read, with room for implementation detail.
    expect(indexedBreakReads).toBeLessThan(matchCount * 16);
  });

  test("anchors a composed query through zero-width combining geometry", async () => {
    const decomposed = content([
      item("e", 100, 640, 10),
      {
        ...item("\u0301", 110, 640, 0),
        width: 0,
      },
    ]);
    const decomposedPage = buildAnchorPageText(1, decomposed, page);
    const resolved = (await resolveAnnotationSpecAnchors(
      anchoredSpec({ quote: "é" }),
      1,
      async () => decomposedPage,
    )) as { annotations: Array<Record<string, unknown>> };
    expect(resolved.annotations[0]!.rects).toEqual([
      { x: 100, y: 637, w: 10, h: 12 },
    ]);
  });

  test("uses the same runtime replacement semantics for search and anchors", async () => {
    const actualText = content([
      { type: "beginMarkedContentProps", actualText: "Readable label" },
      item("\u0001", 100, 600, 20),
      item("\u0002", 120, 600, 20),
      { type: "endMarkedContent" },
    ]);
    const extracted = semanticTextContentToString(actualText);
    const anchorPageText = buildAnchorPageText(1, actualText, page);
    expect(extracted).toBe("Readable label");
    expect(anchorPageText.index.text).toBe(extracted);
    expect(
      findMatches([{ pageId: "p", pageNumber: 1, text: extracted }], "label"),
    ).toHaveLength(1);
    await expect(
      resolveAnnotationSpecAnchors(
        anchoredSpec({ quote: "Readable label" }),
        1,
        async () => anchorPageText,
      ),
    ).resolves.toMatchObject({
      annotations: [{ quote: "Readable label", page: 1 }],
    });
  });

  test("resolves note anchors to an at point", async () => {
    const resolved = (await resolveAnnotationSpecAnchors(
      { annotations: [{ type: "note", text: "hi", anchor: { quote: "fox" } }] },
      2,
      loader,
    )) as { annotations: Array<Record<string, unknown>> };
    expect(resolved.annotations[0]).toMatchObject({
      type: "note",
      page: 1,
      at: { x: 174, y: 697 },
      text: "hi",
    });
  });

  test("errors on zero matches with actionable guidance", async () => {
    await expect(
      resolveAnnotationSpecAnchors(anchoredSpec({ quote: "absent" }), 2, loader),
    ).rejects.toThrow(/was not found in pages 1-2.*shiori search/);
  });

  test("lists candidates for ambiguous quotes", async () => {
    const promise = resolveAnnotationSpecAnchors(
      anchoredSpec({ quote: "quick" }),
      2,
      loader,
    );
    await expect(promise).rejects.toBeInstanceOf(AnchorResolutionError);
    await expect(promise).rejects.toThrow(
      /matches 3 times in pages 1-2.*page 1 occurrence 1 \(global occurrence 1\).*page 2 occurrence 1 \(global occurrence 2\).*page 2 occurrence 2 \(global occurrence 3\)/,
    );

    const repeatedContent = content(
      Array.from({ length: 12 }, (_, index) =>
        item("x", 72 + index * 10, 640, 6),
      ),
    );
    const repeatedPage = buildAnchorPageText(1, repeatedContent, page);
    await expect(
      resolveAnnotationSpecAnchors(
        anchoredSpec({ quote: "x" }),
        1,
        async () => repeatedPage,
      ),
    ).rejects.toThrow(/matches 12 times.*and 4 more/);
  });

  test("occurrence and page disambiguate", async () => {
    const global = (await resolveAnnotationSpecAnchors(
      anchoredSpec({ quote: "quick", occurrence: 3 }),
      2,
      loader,
    )) as { annotations: Array<Record<string, unknown>> };
    expect(global.annotations[0]!.page).toBe(2);
    expect((global.annotations[0]!.rects as unknown[])).toHaveLength(1);

    const paged = (await resolveAnnotationSpecAnchors(
      anchoredSpec({ quote: "quick", page: 2, occurrence: 2 }),
      2,
      loader,
    )) as { annotations: Array<Record<string, unknown>> };
    expect(paged.annotations[0]!.page).toBe(2);

    await expect(
      resolveAnnotationSpecAnchors(
        anchoredSpec({ quote: "quick", page: 1, occurrence: 2 }),
        2,
        loader,
      ),
    ).rejects.toThrow(/occurrence is 2 but the quote matches 1 time on page 1/);
  });

  test("reports provenance per anchored annotation for post-parse attachment", async () => {
    const seen = new Map<number, OverlayTextAnchor>();
    const spec = {
      annotations: [
        { type: "highlight", page: 1, rects: [{ x: 1, y: 1, w: 2, h: 2 }] },
        { type: "highlight", anchor: { quote: "quick", page: 2, occurrence: 2 } },
        { type: "note", text: "hi", anchor: { quote: "brown fox" } },
      ],
    };
    await resolveAnnotationSpecAnchors(spec, 2, loader, {
      onAnchorResolved: (index, anchor) => seen.set(index, anchor),
    });
    // Coordinate annotations report nothing; anchored ones report the page
    // and PAGE-LOCAL occurrence they landed on plus the exact matched text.
    expect([...seen.keys()].sort()).toEqual([1, 2]);
    expect(seen.get(1)).toEqual({ quote: "quick", page: 2, occurrence: 2 });
    expect(seen.get(2)).toEqual({ quote: "brown fox", page: 1, occurrence: 1 });

    const overlays = [
      { type: "highlight", id: "a" },
      { type: "highlight", id: "b" },
      { type: "note", id: "c" },
    ] as unknown as Overlay[];
    const attached = attachResolvedAnchors(overlays, seen);
    expect(attached[0]).toBe(overlays[0]);
    expect(attached[1]).toMatchObject({ id: "b", anchor: seen.get(1) });
    expect(attached[2]).toMatchObject({ id: "c", anchor: seen.get(2) });
    // No provenance -> the same array back, untouched.
    expect(attachResolvedAnchors(overlays, undefined)).toBe(overlays);
    expect(attachResolvedAnchors(overlays, new Map())).toBe(overlays);
  });

  test("stops at the requested occurrence and reuses identical selectors", async () => {
    const loaded: number[] = [];
    const first = (await resolveAnnotationSpecAnchors(
      anchoredSpec({ quote: "quick", occurrence: 1 }),
      2,
      async (pageNumber) => {
        loaded.push(pageNumber);
        return loader(pageNumber);
      },
    )) as { annotations: Array<Record<string, unknown>> };
    expect(first.annotations[0]!.page).toBe(1);
    expect(loaded).toEqual([1]);

    const pageOne = await loader(1);
    let loads = 0;
    const duplicate = await resolveAnnotationSpecAnchors(
      {
        annotations: [
          { type: "highlight", anchor: { quote: "brown", page: 1, occurrence: 1 } },
          { type: "underline", anchor: { quote: " BROWN ", page: 1, occurrence: 1 } },
        ],
      },
      1,
      async () => {
        loads += 1;
        return pageOne;
      },
      { maxSearchWork: pageOne.searchIndex.folded.length },
    );
    expect((duplicate as { annotations: unknown[] }).annotations).toHaveLength(2);
    expect(loads).toBe(1);
  });

  test("rejects excessive distinct full-text anchor work", async () => {
    const pageOne = await loader(1);
    await expect(
      resolveAnnotationSpecAnchors(
        {
          annotations: [
            { type: "highlight", anchor: { quote: "brown", page: 1, occurrence: 1 } },
            { type: "underline", anchor: { quote: "fox", page: 1, occurrence: 1 } },
          ],
        },
        1,
        async () => pageOne,
        { maxSearchWork: pageOne.searchIndex.folded.length },
      ),
    ).rejects.toThrow(/safe work budget.*anchor\.page/);
  });

  test("caller options can lower safety budgets but cannot raise hard caps", async () => {
    const pageOne = await loader(1);
    const oversizedSearch = {
      ...pageOne,
      searchIndex: {
        ...pageOne.searchIndex,
        folded: { length: MAX_ANCHOR_SEARCH_WORK + 1 } as unknown as string,
      },
    };
    await expect(
      resolveAnnotationSpecAnchors(
        anchoredSpec({ quote: "brown", page: 1 }),
        1,
        async () => oversizedSearch,
        { maxSearchWork: Number.MAX_SAFE_INTEGER },
      ),
    ).rejects.toThrow(/safe work budget/);

    const oversizedUnits = {
      ...pageOne,
      units: {
        length: MAX_ANCHOR_INDEXED_TEXT_UNITS + 1,
      } as unknown as AnchorPageText["units"],
    };
    await expect(
      resolveAnnotationSpecAnchors(
        anchoredSpec({ quote: "brown", page: 1 }),
        1,
        async () => oversizedUnits,
        { maxIndexedTextUnits: Number.MAX_SAFE_INTEGER },
      ),
    ).rejects.toThrow(/safe retained-text budget/);
  });

  test("bounds unique page text retained for anchor geometry", async () => {
    const pageOne = await loader(1);
    await expect(
      resolveAnnotationSpecAnchors(
        anchoredSpec({ quote: "absent" }),
        2,
        loader,
        {
          maxIndexedTextCharacters: pageOne.index.text.length,
          maxIndexedTextUnits: pageOne.units.length + 10,
          maxSourceItems: pageOne.sourceItemCount,
        },
      ),
    ).rejects.toThrow(/safe retained-text budget/);
  });

  test("counts raw and runtime replacement data across every searched page", async () => {
    const actualTextPage = (pageNumber: number, label: string) =>
      buildAnchorPageText(
        pageNumber,
        content([
          { type: "beginMarkedContentProps", actualText: label },
          item("\u0001", 72, 700, 12),
          { type: "endMarkedContent" },
        ]),
        page,
      );
    const first = actualTextPage(1, "first");
    const second = actualTextPage(2, "second");
    expect(first.sourceCharacterCount).toBeGreaterThan(first.index.text.length);
    let loads = 0;

    await expect(
      resolveAnnotationSpecAnchors(
        anchoredSpec({ quote: "absent" }),
        2,
        async (pageNumber) => {
          loads += 1;
          return pageNumber === 1 ? first : second;
        },
        {
          maxIndexedTextCharacters: 1_000,
          maxIndexedTextUnits: 1_000,
          maxIndexedTextSpans: 1_000,
          maxSearchMappingExceptions: 1_000,
          maxSourceItems: first.sourceItemCount,
          maxSourceCharacters: 1_000,
          maxRetainedRuns: 1_000,
        },
      ),
    ).rejects.toThrow(/safe retained-text budget/);
    expect(loads).toBe(2);
  });

  test("bounds compact spans and normalization maps retained across pages", async () => {
    const pageOne = await loader(1);
    await expect(
      resolveAnnotationSpecAnchors(
        anchoredSpec({ quote: "absent" }),
        2,
        loader,
        {
          maxIndexedTextSpans: pageOne.index.spans.length,
          maxSearchMappingExceptions:
            pageOne.searchIndex.mappingExceptions.length + 10,
        },
      ),
    ).rejects.toThrow(/safe retained-text budget/);
  });

  test("checks caller cancellation between annotations, pages, and matches", async () => {
    const cancelled = new Error("deadline exceeded");
    let checks = 0;
    const promise = resolveAnnotationSpecAnchors(
      anchoredSpec({ quote: "quick", occurrence: 1 }),
      2,
      loader,
      {
        checkAbort: () => {
          checks += 1;
          if (checks === 5) throw cancelled;
        },
      },
    );
    await expect(promise).rejects.toBe(cancelled);
    expect(checks).toBe(5);
  });

  test("rejects geometry amplification before allocating oversized rect output", async () => {
    const denseActualText = content([
      { type: "beginMarkedContentProps", actualText: "token" },
      ...Array.from({ length: 10_001 }, (_, index) =>
        item(
          "x",
          20 + (index % 100) * 5,
          740 - Math.floor(index / 100) * 5,
          4,
        ),
      ),
      { type: "endMarkedContent" },
    ]);
    const densePage = buildAnchorPageText(1, denseActualText, page);
    await expect(
      resolveAnnotationSpecAnchors(
        anchoredSpec({ quote: "token" }),
        1,
        async () => densePage,
      ),
    ).rejects.toThrow(/exceeds 10000 rectangles/);
    await expect(
      resolveAnnotationSpecAnchors(
        { annotations: [{ type: "note", anchor: { quote: "token" } }] },
        1,
        async () => densePage,
        { maxGeometryWork: 100 },
      ),
    ).rejects.toThrow(/geometry exceeds the safe work budget/);
  });

  test("caches repeated range geometry within one operation", async () => {
    const actualText = content([
      { type: "beginMarkedContentProps", actualText: "token" },
      ...Array.from({ length: 100 }, (_, index) =>
        item("x", 20 + index * 4, 700, 3),
      ),
      { type: "endMarkedContent" },
    ]);
    const anchorPage = buildAnchorPageText(1, actualText, page);
    await expect(
      resolveAnnotationSpecAnchors(
        {
          annotations: Array.from({ length: 100 }, () => ({
            type: "note",
            anchor: { quote: "token" },
          })),
        },
        1,
        async () => anchorPage,
        { maxGeometryWork: 500 },
      ),
    ).resolves.toMatchObject({ annotations: expect.any(Array) });
  });

  test("classifies oversized page text as unavailable rather than a bad anchor", () => {
    const oversized = content([
      item("x".repeat(2_000_001), 0, 0, 1),
    ]);
    expect(() => buildAnchorPageText(1, oversized, page)).toThrow(
      AnchorTextUnavailableError,
    );
  });

  test("rejects out-of-range anchor pages", async () => {
    await expect(
      resolveAnnotationSpecAnchors(anchoredSpec({ quote: "x", page: 9 }), 2, loader),
    ).rejects.toThrow(/anchor\.page is 9 but the document has 2 pages/);
    await expect(
      resolveAnnotationSpecAnchors(
        anchoredSpec({ quote: "brown", page: "1" }),
        2,
        loader,
      ),
    ).rejects.toThrow(/anchor\.page must be a 1-based integer/);
    await expect(
      resolveAnnotationSpecAnchors(
        {
          annotations: [
            {
              type: "highlight",
              page: null,
              rects: null,
              quote: null,
              anchor: { quote: "brown" },
            },
          ],
        },
        2,
        loader,
      ),
    ).rejects.toThrow(/anchor and annotations\[0\]\.rects are mutually exclusive/);
  });

  test("bounds error messages to 2048 bytes", async () => {
    const long = "quick ".repeat(400).trim();
    let message = "";
    try {
      await resolveAnnotationSpecAnchors(anchoredSpec({ quote: long }), 2, loader);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.length).toBeGreaterThan(0);
    expect(new TextEncoder().encode(message).byteLength).toBeLessThanOrEqual(2_048);
    expect(new AnchorResolutionError("x".repeat(2_048)).message).toBe(
      "x".repeat(2_048),
    );
    const truncated = new AnchorResolutionError("🚀".repeat(20_000)).message;
    expect(new TextEncoder().encode(truncated).byteLength).toBeLessThanOrEqual(
      2_048,
    );
    expect(truncated.endsWith("…")).toBe(true);
  });

  test("loads each page once across multiple anchors", async () => {
    let loads = 0;
    const counting = (pageNumber: number) => {
      loads += 1;
      return loader(pageNumber);
    };
    await resolveAnnotationSpecAnchors(
      {
        annotations: [
          { type: "highlight", anchor: { quote: "brown fox" } },
          { type: "underline", anchor: { quote: "The quick", page: 1 } },
        ],
      },
      2,
      counting,
    );
    expect(loads).toBe(2);
  });
});

describe("annotationSpecViolation anchor rules", () => {
  const base = { type: "highlight", anchor: { quote: "q" } };
  test("accepts a well-formed anchor and enforces exclusivity", () => {
    expect(annotationSpecViolation([base])).toBeNull();
    expect(
      annotationSpecViolation([{ ...base, rects: [{ x: 1, y: 1, w: 1, h: 1 }] }]),
    ).toMatch(/mutually exclusive/);
    expect(annotationSpecViolation([{ ...base, page: 1 }])).toMatch(
      /page must be omitted/,
    );
    expect(annotationSpecViolation([{ ...base, quote: "x" }])).toMatch(
      /written by anchor resolution/,
    );
    expect(
      annotationSpecViolation([{ type: "ink", anchor: { quote: "q" } }]),
    ).toMatch(/only supported for/);
    expect(
      annotationSpecViolation([
        { type: "highlight", anchor: { quote: "q", prefix: "p" } },
      ]),
    ).toMatch(/anchor\.prefix is not supported/);
    expect(
      annotationSpecViolation([{ type: "highlight", anchor: { quote: " " } }]),
    ).toMatch(/non-empty string/);
    expect(
      annotationSpecViolation([
        { type: "highlight", anchor: { quote: "q", occurrence: 0 } },
      ]),
    ).toMatch(/occurrence must be a 1-based integer/);
  });

  test("treats explicit null placeholders as present anchor conflicts", () => {
    expect(
      annotationSpecViolation([{ type: "highlight", anchor: null }]),
    ).toMatch(/anchor must be an object/);
    expect(annotationSpecViolation([{ ...base, page: null }])).toMatch(
      /page must be omitted/,
    );
    expect(annotationSpecViolation([{ ...base, rects: null }])).toMatch(
      /mutually exclusive/,
    );
    expect(annotationSpecViolation([{ ...base, quote: null }])).toMatch(
      /quote.*must be omitted/,
    );
    expect(
      annotationSpecViolation([
        { type: "note", anchor: { quote: "q" }, at: null },
      ]),
    ).toMatch(/mutually exclusive/);
    expect(
      annotationSpecViolation([
        { type: "highlight", anchor: { quote: "q", page: null } },
      ]),
    ).toMatch(/anchor\.page must be a 1-based integer/);
    expect(
      annotationSpecViolation([
        { type: "highlight", anchor: { quote: "q", occurrence: null } },
      ]),
    ).toMatch(/anchor\.occurrence must be a 1-based integer/);
  });

  test("anchor quotes count toward the text budgets", () => {
    expect(
      annotationSpecViolation([
        { type: "highlight", anchor: { quote: "q".repeat(40_000) } },
      ]),
    ).toMatch(/anchor\.quote exceeds/);
  });

  test("bounds total rectangles across otherwise-valid annotations", () => {
    const rect = { x: 1, y: 1, w: 1, h: 1 };
    const annotations = Array.from({ length: 11 }, () => ({
      type: "highlight",
      page: 1,
      rects: Array(10_000).fill(rect),
    }));
    expect(annotationSpecViolation(annotations)).toMatch(
      /100000 rectangles in total/,
    );
  });
});
