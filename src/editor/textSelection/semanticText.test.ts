import { describe, expect, test } from "bun:test";
import type { PdfPageTextContent as TextContent } from "../../pdf/engine/text";
import {
  MAX_SEMANTIC_MARKED_CONTENT_DEPTH,
  MAX_SEMANTIC_SOURCE_CHARACTERS_PER_PAGE,
  MAX_SEMANTIC_SEARCH_SPANS_PER_PAGE,
  SemanticTextLimitError,
  buildSemanticTextLayerModel,
  semanticRangeToUnitOffsets,
  semanticTextContentToString,
  semanticUnitsToSearchIndex,
  semanticUnitsToString,
} from "./semanticText";

describe("semantic text extraction", () => {
  test("prefers runtime-provided item replacement text when present", () => {
    const textContent = {
      items: [
        {
          str: "\u0001",
          actualText: "α",
          dir: "ltr",
          width: 10,
          height: 10,
          transform: [1, 0, 0, 1, 0, 0],
          fontName: "f1",
          hasEOL: false,
        },
      ],
      styles: {},
      lang: null,
    } satisfies TextContent;

    expect(semanticTextContentToString(textContent)).toBe("α");
  });

  test("collapses runtime-provided marked-content replacement into one unit", () => {
    const textContent = {
      items: [
        {
          type: "beginMarkedContentProps",
          id: "mc1",
          actualText: "alpha beta",
        },
        {
          str: "\u0001",
          dir: "ltr",
          width: 10,
          height: 10,
          transform: [1, 0, 0, 1, 0, 0],
          fontName: "f1",
          hasEOL: false,
        },
        {
          str: "\u0002",
          dir: "ltr",
          width: 10,
          height: 10,
          transform: [1, 0, 0, 1, 10, 0],
          fontName: "f1",
          hasEOL: true,
        },
        {
          type: "endMarkedContent",
          id: "mc1",
        },
      ],
      styles: {},
      lang: null,
    } satisfies TextContent;

    const model = buildSemanticTextLayerModel(textContent);

    expect(model.textDivCount).toBe(2);
    expect(model.units).toEqual([
      {
        kind: "actualText",
        startDivIndex: 0,
        endDivIndex: 1,
        text: "alpha beta",
        hasEOL: true,
        joinWithPrevious: false,
      },
    ]);
    expect(
      semanticUnitsToString(model.units, { preserveLineBreaks: true }),
    ).toBe("alpha beta");
  });

  test("treats an empty runtime replacement as deliberate", () => {
    const textContent = {
      items: [
        { type: "beginMarkedContentProps", actualText: "" },
        {
          str: "secret raw glyphs",
          dir: "ltr",
          width: 50,
          height: 10,
          transform: [10, 0, 0, 10, 0, 0],
          fontName: "f1",
          hasEOL: false,
        },
        { type: "endMarkedContent" },
      ],
      styles: {},
      lang: null,
    } as unknown as TextContent;
    expect(semanticTextContentToString(textContent)).toBe("");
  });

  test("builds a normalized search index with unit character mapping", () => {
    const index = semanticUnitsToSearchIndex([
      {
        kind: "text",
        divIndex: 0,
        text: "Alpha",
        rawText: "Alpha",
        hasEOL: false,
      },
      {
        kind: "text",
        divIndex: 1,
        text: "  Beta",
        rawText: "  Beta",
        hasEOL: false,
      },
    ]);

    expect(index.text).toBe("Alpha Beta");
    expect(
      Array.from(
        semanticRangeToUnitOffsets(index, { start: 0, end: 1 }).entries(),
      ),
    ).toEqual([[0, { startOffset: 0, endOffset: 1 }]]);
    expect(
      Array.from(
        semanticRangeToUnitOffsets(index, { start: 6, end: 7 }).entries(),
      ),
    ).toEqual([[1, { startOffset: 2, endOffset: 3 }]]);
  });

  test("rejects oversized semantic text before building its search index", () => {
    const oversized = {
      items: [
        {
          str: "x".repeat(MAX_SEMANTIC_SOURCE_CHARACTERS_PER_PAGE + 1),
          dir: "ltr",
          width: 1,
          height: 1,
          transform: [1, 0, 0, 1, 0, 0],
          fontName: "f1",
          hasEOL: false,
        },
      ],
      styles: {},
      lang: null,
    } as unknown as TextContent;
    expect(() => buildSemanticTextLayerModel(oversized)).toThrow(
      SemanticTextLimitError,
    );
  });

  test("rejects adversarial alternating text before allocating span objects", () => {
    const units = [
      {
        kind: "text" as const,
        divIndex: 0,
        text: "a ".repeat(MAX_SEMANTIC_SEARCH_SPANS_PER_PAGE),
        rawText: "a ".repeat(MAX_SEMANTIC_SEARCH_SPANS_PER_PAGE),
        hasEOL: false,
      },
    ];
    expect(() => semanticUnitsToSearchIndex(units)).toThrow(
      SemanticTextLimitError,
    );
  });

  test("rejects deeply nested marked content without scanning the stack quadratically", () => {
    const nested = {
      items: Array.from(
        { length: MAX_SEMANTIC_MARKED_CONTENT_DEPTH + 1 },
        () => ({ type: "beginMarkedContent" }),
      ),
      styles: {},
      lang: null,
    } as unknown as TextContent;
    expect(() => buildSemanticTextLayerModel(nested)).toThrow(
      SemanticTextLimitError,
    );
  });

  test("rejects unbalanced marked content instead of silently dropping text", () => {
    const unclosed = {
      items: [
        { type: "beginMarkedContentProps", actualText: "replacement" },
        {
          str: "raw",
          dir: "ltr",
          width: 10,
          height: 10,
          transform: [10, 0, 0, 10, 0, 0],
          fontName: "f1",
          hasEOL: false,
        },
      ],
      styles: {},
      lang: null,
    } as unknown as TextContent;
    expect(() => buildSemanticTextLayerModel(unclosed)).toThrow(
      "unbalanced marked content",
    );
  });

  test("joins visually contiguous per-glyph Latin text", () => {
    const glyph = (str: string, x: number, width = 6) => ({
      str,
      dir: "ltr",
      width,
      height: 10,
      transform: [10, 0, 0, 10, x, 100],
      fontName: "f1",
      hasEOL: false,
    });
    const model = buildSemanticTextLayerModel({
      items: [
        glyph("H", 0),
        glyph("e", 6),
        glyph("l", 12),
        glyph("l", 18),
        glyph("o", 24),
        glyph("A", 100),
      ],
      styles: {},
      lang: null,
    } as unknown as TextContent);
    expect(semanticUnitsToSearchIndex(model.units).text).toBe("Hello A");
  });

  test("falls back to script-aware joining when glyph geometry is unavailable", () => {
    const model = buildSemanticTextLayerModel({
      items: [
        { str: "中", hasEOL: false },
        { str: "文", hasEOL: false },
      ],
      styles: {},
      lang: null,
    } as unknown as TextContent);
    expect(semanticUnitsToSearchIndex(model.units).text).toBe("中文");
  });

  test("indexes the maximum per-glyph CJK page without quadratic rescans", () => {
    const units = Array.from(
      { length: MAX_SEMANTIC_SEARCH_SPANS_PER_PAGE },
      (_, divIndex) => ({
        kind: "text" as const,
        divIndex,
        text: "中",
        rawText: "中",
        hasEOL: false,
      }),
    );
    const index = semanticUnitsToSearchIndex(units);
    expect(index.text.length).toBe(MAX_SEMANTIC_SEARCH_SPANS_PER_PAGE);
    expect(index.spans).toHaveLength(MAX_SEMANTIC_SEARCH_SPANS_PER_PAGE);
  });

  test("does not space out adjacent CJK characters (so 中文 stays searchable)", () => {
    // Text content often carries CJK as per-glyph items → one unit per character.
    // The old unconditional separator made the index "中 文 文 档", so an
    // indexOf("中文") search could never match.
    const cjk = (text: string, divIndex: number) => ({
      kind: "text" as const,
      divIndex,
      text,
      rawText: text,
      hasEOL: false,
    });
    const index = semanticUnitsToSearchIndex([
      cjk("中", 0),
      cjk("文", 1),
      cjk("文", 2),
      cjk("档", 3),
    ]);
    expect(index.text).toBe("中文文档");
    expect(index.text.indexOf("中文")).toBe(0);
  });

  test("keeps a searchable separator across a real CJK line break", () => {
    const unit = (
      text: string,
      divIndex: number,
      hasEOL = false,
      softLineBreakWithPrevious = false,
    ) => ({
      kind: "text" as const,
      divIndex,
      text,
      rawText: text,
      hasEOL,
      softLineBreakWithPrevious,
    });
    expect(
      semanticUnitsToSearchIndex([
        unit("中", 0, true),
        unit("文", 1, false, true),
      ]),
    ).toMatchObject({
      text: "中 文",
      layoutBreaks: [{ start: 1, end: 2 }],
    });
  });

  test("marks a line-wrap hyphen as optional without changing extracted text", () => {
    const unit = (
      text: string,
      divIndex: number,
      hasEOL = false,
      softLineBreakWithPrevious = false,
    ) => ({
      kind: "text" as const,
      divIndex,
      text,
      rawText: text,
      hasEOL,
      softLineBreakWithPrevious,
    });
    expect(
      semanticUnitsToSearchIndex([
        unit("inter-", 0, true),
        unit("national", 1, false, true),
      ]),
    ).toMatchObject({
      text: "inter- national",
      layoutBreaks: [{ start: 6, end: 7, dehyphenateStart: 5 }],
    });
  });

  test("distinguishes a visual wrap from a paragraph gap", () => {
    const item = (
      str: string,
      x: number,
      y: number,
      hasEOL: boolean,
    ) => ({
      str,
      dir: "ltr",
      width: 60,
      height: 10,
      transform: [10, 0, 0, 10, x, y],
      fontName: "f1",
      hasEOL,
    });
    const model = buildSemanticTextLayerModel({
      items: [
        item("wrapped", 72, 700, true),
        item("line", 72, 688, true),
        item("paragraph", 72, 660, false),
      ],
      styles: {},
      lang: null,
    } as unknown as TextContent);
    expect(semanticUnitsToSearchIndex(model.units)).toMatchObject({
      text: "wrapped line paragraph",
      layoutBreaks: [{ start: 7, end: 8 }],
      hardBreaks: [{ start: 12, end: 13 }],
    });
  });

  test("keeps short paragraphs hard at ordinary line leading", () => {
    const item = (
      str: string,
      width: number,
      y: number,
      hasEOL: boolean,
    ) => ({
      str,
      dir: "ltr",
      width,
      height: 10,
      transform: [10, 0, 0, 10, 72, y],
      fontName: "f1",
      hasEOL,
    });
    const model = buildSemanticTextLayerModel({
      items: [
        item("Short end.", 38, 700, true),
        item("Next paragraph.", 48, 688, false),
      ],
      styles: {},
      lang: null,
    } as unknown as TextContent);

    expect(semanticUnitsToSearchIndex(model.units)).toMatchObject({
      text: "Short end. Next paragraph.",
      layoutBreaks: [],
      hardBreaks: [{ start: 10, end: 11 }],
    });
  });

  test("keeps adjacent lines in different columns hard", () => {
    const item = (str: string, x: number, y: number, hasEOL: boolean) => ({
      str,
      dir: "ltr",
      width: 100,
      height: 10,
      transform: [10, 0, 0, 10, x, y],
      fontName: "f1",
      hasEOL,
    });
    const model = buildSemanticTextLayerModel({
      items: [
        item("right column end", 300, 700, true),
        item("next left column", 72, 688, false),
      ],
      styles: {},
      lang: null,
    } as unknown as TextContent);

    expect(semanticUnitsToSearchIndex(model.units)).toMatchObject({
      layoutBreaks: [],
      hardBreaks: [{ start: 16, end: 17 }],
    });
  });

  test("uses the complete previous visual line for wrap classification", () => {
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      hasEOL: boolean,
    ) => ({
      str,
      dir: "ltr",
      width,
      height: 10,
      transform: [10, 0, 0, 10, x, y],
      fontName: "f1",
      hasEOL,
    });
    const model = buildSemanticTextLayerModel({
      items: [
        item("A deliberately ", 72, 700, 60, false),
        item("split line", 132, 700, 28, true),
        item("continues here", 72, 688, 62, false),
      ],
      styles: {},
      lang: null,
    } as unknown as TextContent);
    const index = semanticUnitsToSearchIndex(model.units);

    expect(index.text).toBe("A deliberately split line continues here");
    expect(index.layoutBreaks).toHaveLength(1);
    expect(index.hardBreaks).toEqual([]);
  });

  test("keeps the separator between a CJK run and a Latin run", () => {
    const index = semanticUnitsToSearchIndex([
      { kind: "text", divIndex: 0, text: "中文", rawText: "中文", hasEOL: false },
      { kind: "text", divIndex: 1, text: "PDF", rawText: "PDF", hasEOL: false },
    ]);
    expect(index.text).toBe("中文 PDF");
  });

  test("does not insert spaces around CJK punctuation", () => {
    const unit = (text: string, divIndex: number) => ({
      kind: "text" as const,
      divIndex,
      text,
      rawText: text,
      hasEOL: false,
    });
    expect(
      semanticUnitsToSearchIndex([
        unit("「", 0),
        unit("中", 1),
        unit("文", 2),
        unit("，", 3),
        unit("测", 4),
        unit("试", 5),
        unit("」", 6),
      ]).text,
    ).toBe("「中文，测试」");
  });

  test("preserves CJK joins and real line breaks in semantic clipboard text", () => {
    const unit = (
      text: string,
      divIndex: number,
      hasEOL = false,
    ) => ({
      kind: "text" as const,
      divIndex,
      text,
      rawText: text,
      hasEOL,
    });
    expect(
      semanticUnitsToString(
        [unit("中", 0), unit("文", 1, true), unit("下", 2), unit("一", 3)],
        { preserveLineBreaks: true },
      ),
    ).toBe("中文\n下一");
  });

  test("does not split supplementary CJK or grapheme continuation units", () => {
    const unit = (text: string, divIndex: number) => ({
      kind: "text" as const,
      divIndex,
      text,
      rawText: text,
      hasEOL: false,
    });
    expect(
      semanticUnitsToSearchIndex([unit("𠀀", 0), unit("𠀁", 1)]).text,
    ).toBe("𠀀𠀁");
    expect(
      semanticUnitsToSearchIndex([unit("e", 0), unit("\u0301", 1)]).text,
    ).toBe("e\u0301");
    expect(
      semanticUnitsToSearchIndex([unit("漢", 0), unit("\u{E0100}", 1)]).text,
    ).toBe("漢\u{E0100}");
    expect(
      semanticUnitsToSearchIndex([
        unit("👩", 0),
        unit("\u200d", 1),
        unit("💻", 2),
      ]).text,
    ).toBe("👩‍💻");
  });
});
