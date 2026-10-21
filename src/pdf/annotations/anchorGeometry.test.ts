import { describe, expect, test } from "bun:test";
import type { PdfPageTextContent as TextContent } from "../engine/text";
import { pageTextFromPdfiumGlyphs, type PdfiumGlyph } from "../engine/pdfiumText";
import type { PageModel } from "../model/types";
import {
  buildSemanticTextLayerModel,
  semanticUnitsToSearchIndex,
} from "../../editor/textSelection/semanticText";
import { findMatches } from "../../editor/search/findMatches";
import {
  MAX_NARROW_QUOTE_OFFSETS_PER_PAGE,
  charRangeToPageRects,
  textContentToPdfRunMap,
  textContentToPdfRuns,
} from "./anchorGeometry";

const page: PageModel = {
  id: "page-1",
  sourceIndex: 0,
  rotation: 0,
  originXPt: 0,
  originYPt: 0,
  widthPt: 612,
  heightPt: 792,
};

type ItemOptions = {
  width?: number;
  fontHeight?: number;
  dir?: string;
  fontName?: string;
  hasEOL?: boolean;
  transform?: number[];
};

function item(str: string, x: number, y: number, options: ItemOptions = {}) {
  const fontHeight = options.fontHeight ?? 12;
  return {
    str,
    dir: options.dir ?? "ltr",
    transform: options.transform ?? [fontHeight, 0, 0, fontHeight, x, y],
    width: options.width ?? str.length * 6,
    height: fontHeight,
    fontName: options.fontName ?? "f1",
    hasEOL: options.hasEOL ?? false,
  };
}

function content(items: unknown[], styles?: Record<string, unknown>): TextContent {
  return {
    items,
    styles: styles ?? {
      f1: { ascent: 0.75, descent: -0.25, fontFamily: "serif", vertical: false },
    },
  } as unknown as TextContent;
}

function resolve(textContent: TextContent, query: string, pageModel = page) {
  const units = buildSemanticTextLayerModel(textContent).units;
  const index = semanticUnitsToSearchIndex(units);
  const runMap = textContentToPdfRunMap(textContent, pageModel);
  const matches = findMatches(
    [{ pageId: pageModel.id, pageNumber: 1, text: index.text }],
    query,
  );
  expect(matches.length).toBeGreaterThan(0);
  const match = matches[0]!;
  return charRangeToPageRects(
    { start: match.index, end: match.end },
    index,
    units,
    runMap.runs,
    runMap.visibleRuns,
  );
}

describe("textContentToPdfRuns", () => {
  test("computes baseline-anchored page-local boxes with style metrics", () => {
    const runs = textContentToPdfRuns(
      content([item("Hello", 100, 720, { width: 50 })]),
      page,
    );
    expect(runs).toHaveLength(1);
    // ascent 0.75 * 12 = 9, descent 0.25 * 12 = 3.
    expect(runs[0]).toEqual({
      rect: { x: 100, y: 717, w: 50, h: 12 },
      baselineYPt: 720,
      text: "Hello",
    });
  });

  test("keeps one aligned slot per str item, null for whitespace and vertical", () => {
    const runs = textContentToPdfRuns(
      content([
        item("A", 100, 720),
        item(" ", 110, 720),
        item("B", 120, 720, { dir: "ttb" }),
        { type: "beginMarkedContent" },
        item("C", 140, 720),
      ]),
      page,
    );
    // Marked-content items are not text divs; the rest align by ordinal.
    expect(runs).toHaveLength(4);
    expect(runs[0]?.text).toBe("A");
    expect(runs[1]).toBeNull();
    expect(runs[2]).toBeNull();
    expect(runs[3]?.text).toBe("C");
  });

  test("rejects rotated baselines and ratio-falls-back without style metrics", () => {
    const runs = textContentToPdfRuns(
      content(
        [
          item("Rotated", 100, 400, { transform: [0, 12, -12, 0, 100, 400] }),
          item("Plain", 100, 100, { fontName: "missing" }),
        ],
        {},
      ),
      page,
    );
    expect(runs[0]).toBeNull();
    // 0.8/0.2 fixed ratios: y = 100 - 2.4, h = 12.
    expect(runs[1]?.rect).toEqual({ x: 100, y: 97.6, w: 30, h: 12 });
  });

  test("clamps oversized font bboxes to the TextItem em height", () => {
    const runs = textContentToPdfRuns(
      content(
        [item("中文", 92.55, 133.8, { width: 21.6, fontHeight: 10.8 })],
        {
          f1: {
            ascent: 1.06,
            descent: -0.34,
            fontFamily: "serif",
            vertical: false,
          },
        },
      ),
      page,
    );
    // The source PDF that exposed the bug reports a 1.40em font bbox. The
    // highlight band must stay one 10.8pt em tall while preserving its
    // baseline-relative 1.06:0.34 ascent/descent proportions.
    expect(runs[0]?.rect).toEqual({ x: 92.55, y: 131.18, w: 21.6, h: 10.8 });
  });

  test("subtracts a non-zero MediaBox origin", () => {
    const offsetPage: PageModel = { ...page, originXPt: 50, originYPt: 100 };
    const runs = textContentToPdfRuns(
      content([item("Hi", 150, 300, { width: 20 })]),
      offsetPage,
    );
    expect(runs[0]?.rect.x).toBe(100);
    expect(runs[0]?.baselineYPt).toBe(200);
  });

  test("is independent of page rotation (PDF user space)", () => {
    const rotated: PageModel = { ...page, rotation: 90 };
    const runs = textContentToPdfRuns(
      content([item("Turned", 100, 720, { width: 40 })]),
      rotated,
    );
    expect(runs[0]?.rect).toEqual({ x: 100, y: 717, w: 40, h: 12 });
  });
});

describe("charRangeToPageRects", () => {
  test("clips sub-item coverage proportionally and merges one line", () => {
    const textContent = content([
      item("Hello", 100, 720, { width: 50 }),
      item("world", 155, 720, { width: 50 }),
    ]);
    const { rects, unresolvedUnits } = resolve(textContent, "lo wor");
    expect(unresolvedUnits).toBe(0);
    // "lo" = chars 3..5 of a 5-char run at x=100 w=50 → 130..150;
    // "wor" = chars 0..3 of a 5-char run at x=155 w=50 → 155..185;
    // gap 5pt ≤ 0.6 × 12pt → one merged quad.
    expect(rects).toEqual([{ x: 130, y: 717, w: 55, h: 12 }]);
  });

  test("keeps separate lines separate", () => {
    const textContent = content([
      item("First line", 72, 700, { width: 80 }),
      item("second line", 72, 680, { width: 88 }),
    ]);
    const { rects } = resolve(textContent, "line second");
    expect(rects).toHaveLength(2);
    expect(rects[0]!.y).toBeGreaterThan(rects[1]!.y);
  });

  test("clusters baselines before sorting runs from left to right", () => {
    const textContent = content([
      item("left", 50, 700, { width: 24 }),
      item("right", 400, 701, { width: 30 }),
    ]);
    const { rects } = resolve(textContent, "left right");
    expect(rects).toEqual([
      { x: 50, y: 697, w: 24, h: 12 },
      { x: 400, y: 698, w: 30, h: 12 },
    ]);
  });

  test("resolves CJK queries across per-glyph items", () => {
    const textContent = content([
      item("中", 100, 640, { width: 12 }),
      item("文", 112, 640, { width: 12 }),
    ]);
    const { rects, unresolvedUnits } = resolve(textContent, "中文");
    expect(unresolvedUnits).toBe(0);
    expect(rects).toEqual([{ x: 100, y: 637, w: 24, h: 12 }]);
  });

  test("accounts for narrow CJK quotes inside a combined TextItem", () => {
    const textContent = content(
      [
        item("个给我“资深程序员、研究员”感觉的模型，或者", 92.55, 133.8, {
          width: 224.65077713955057,
          fontHeight: 10.8,
        }),
      ],
      {
        f1: {
          ascent: 1.06,
          descent: -0.34,
          fontFamily: "serif",
          vertical: false,
        },
      },
    );
    const { rects, unresolvedUnits } = resolve(
      textContent,
      "资深程序员、研究员",
    );
    expect(unresolvedUnits).toBe(0);
    expect(rects).toEqual([{ x: 129.27, y: 131.18, w: 97.2, h: 10.8 }]);
  });

  test("keeps legacy uniform slicing for non-quote mixed-width text", () => {
    const cases = [
      { text: "中WWWW目标", width: 70, expected: { x: 50, w: 20 } },
      { text: "中ｶﾅ目标", width: 50, expected: { x: 30, w: 20 } },
      // Legacy geometry addresses TextItem strings by UTF-16 offsets, so the
      // astral emoji occupies two of the five proportional units.
      { text: "中😀目标", width: 50, expected: { x: 30, w: 20 } },
    ];
    for (const fixture of cases) {
      const { rects } = resolve(
        content([item(fixture.text, 0, 640, { width: fixture.width })]),
        "目标",
      );
      expect(rects[0]).toMatchObject({
        x: fixture.expected.x,
        w: fixture.expected.w,
      });
    }
  });

  test("bounds retained quote offsets and falls back as one whole run", () => {
    const text = `中${"“".repeat(MAX_NARROW_QUOTE_OFFSETS_PER_PAGE + 1)}目标`;
    const runs = textContentToPdfRuns(
      content([item(text, 0, 640, { width: text.length * 6 })]),
      page,
    );
    expect(runs[0]?.narrowQuoteEndOffsets).toBeUndefined();
  });

  test("charges logarithmic sparse lookups instead of rescanning a long run", () => {
    const text = `中${"W".repeat(200_000)}“目标”`;
    const textContent = content([
      item(text, 0, 640, { width: text.length * 6 }),
    ]);
    const units = buildSemanticTextLayerModel(textContent).units;
    const index = semanticUnitsToSearchIndex(units);
    const runMap = textContentToPdfRunMap(textContent, page);
    const start = index.text.indexOf("目标");
    let work = 0;
    const result = charRangeToPageRects(
      { start, end: start + 2 },
      index,
      units,
      runMap.runs,
      runMap.visibleRuns,
      { consumeWork: (amount) => (work += amount) },
    );
    expect(result.rects).toHaveLength(1);
    expect(work).toBeLessThan(20);
  });

  test("covers an item-level ActualText replacement with different raw quotes", () => {
    const textContent = content([
      {
        ...item("中“原文”", 100, 640, { width: 50 }),
        actualText: "中文替换标签",
      },
    ]);
    const units = buildSemanticTextLayerModel(textContent).units;
    const runMap = textContentToPdfRunMap(textContent, page);
    expect(units[0]).toMatchObject({
      text: "中文替换标签",
      rawText: "中“原文”",
    });
    expect(runMap.runs[0]?.narrowQuoteEndOffsets).toBeInstanceOf(Uint32Array);
    const { rects, unresolvedUnits } = resolve(textContent, "替换");
    expect(unresolvedUnits).toBe(0);
    expect(rects).toEqual([{ x: 100, y: 637, w: 50, h: 12 }]);
  });

  test("uses semantic-unit length when raw run text has no exact mapping", () => {
    const textContent = content([
      item("中“原文”", 100, 640, { width: 50 }),
    ]);
    const runMap = textContentToPdfRunMap(textContent, page);
    const units = [
      {
        kind: "text" as const,
        divIndex: 0,
        text: "中目标",
        rawText: "中目标",
        hasEOL: false,
      },
    ];
    const index = semanticUnitsToSearchIndex(units);
    const start = index.text.indexOf("目标");
    const { rects } = charRangeToPageRects(
      { start, end: start + 2 },
      index,
      units,
      runMap.runs,
      runMap.visibleRuns,
    );
    // Exact mapping is unavailable, so retain legacy equal-width slicing in
    // the semantic unit's three-character coordinate system: 1/3 .. 3/3.
    expect(rects).toEqual([{ x: 116.67, y: 637, w: 33.33, h: 12 }]);
  });

  test("covers whole ActualText spans", () => {
    const textContent = content([
      { type: "beginMarkedContentProps", actualText: "Replaced" },
      item("Rep", 100, 600, { width: 30 }),
      item("laced", 130, 600, { width: 30 }),
      { type: "endMarkedContent" },
    ]);
    const { rects, unresolvedUnits } = resolve(textContent, "Replaced");
    expect(unresolvedUnits).toBe(0);
    expect(rects).toEqual([{ x: 100, y: 597, w: 60, h: 12 }]);
  });

  test("rejects an ActualText span when any visible run lacks geometry", () => {
    const textContent = content([
      { type: "beginMarkedContentProps", actualText: "Replacement" },
      item("Rep", 100, 600, { width: 30 }),
      item("lacement", 130, 600, {
        width: 48,
        transform: [0, 12, -12, 0, 130, 600],
      }),
      { type: "endMarkedContent" },
    ]);
    const { rects, unresolvedUnits } = resolve(textContent, "Replacement");
    expect(rects).toEqual([{ x: 100, y: 597, w: 30, h: 12 }]);
    expect(unresolvedUnits).toBe(1);
  });

  test("whitespace-only units between words never count as unresolved", () => {
    const textContent = content([
      item("A", 100, 500, { width: 6 }),
      item(" ", 106, 500, { width: 4 }),
      item("B", 110, 500, { width: 6 }),
    ]);
    const { rects, unresolvedUnits } = resolve(textContent, "A B");
    expect(unresolvedUnits).toBe(0);
    expect(rects).toHaveLength(1);
  });

  test("reports units whose geometry is unusable", () => {
    const textContent = content([
      item("visible", 100, 400, { width: 42 }),
      item("hidden", 160, 400, { dir: "ttb", width: 36 }),
    ]);
    const { unresolvedUnits } = resolve(textContent, "visible hidden");
    expect(unresolvedUnits).toBe(1);
  });
});

describe("charRangeToPageRects over PDFium glyph cells", () => {
  // Proportional Helvetica-like advances at 10 pt: "i" and "l" are narrow,
  // "W" and "M" wide, so a UTF-16 share of the item width lands elsewhere.
  const advance: Record<string, number> = { i: 2.22, l: 2.22, t: 2.78, c: 5, W: 9.44, M: 8.33 };
  function line(text: string, x: number, y: number): PdfiumGlyph[] {
    const glyphs: PdfiumGlyph[] = [];
    for (const ch of text) {
      const w = advance[ch] ?? 2.78;
      if (ch === " ") {
        glyphs.push({ ...cell(ch, x, y, 0), generated: true, fontSize: 0 });
      } else glyphs.push(cell(ch, x, y, w));
      x += w;
    }
    return glyphs;
  }
  function cell(text: string, x: number, y: number, w: number): PdfiumGlyph {
    return {
      text,
      origin: [x, y],
      end: [x + w, y],
      fontSize: 10,
      angle: 0,
      generated: false,
      fontName: "Helvetica",
      fontFlags: 32,
      ascent: 7.5,
      descent: -2.5,
    };
  }

  test("covers exactly the matched glyphs, not a share of the line", () => {
    const glyphs = line("illicit little iii WWW MMM", 100, 700);
    const textContent = pageTextFromPdfiumGlyphs(glyphs, null).content;
    const { rects, unresolvedUnits } = resolve(textContent, "WWW");
    expect(unresolvedUnits).toBe(0);
    const first = glyphs.find((glyph) => glyph.text === "W")!;
    const last = glyphs.findLast((glyph) => glyph.text === "W")!;
    expect(rects).toHaveLength(1);
    expect(rects[0]!.x).toBeCloseTo(first.origin[0], 2);
    expect(rects[0]!.x + rects[0]!.w).toBeCloseTo(last.end[0], 2);
  });
});
