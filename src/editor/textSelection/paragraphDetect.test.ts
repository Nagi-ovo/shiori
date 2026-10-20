import { describe, expect, test } from "bun:test";
import type { TextRunDisplayBounds } from "./highlightRects";
import {
  detectParagraphs,
  isMathFontName,
  paragraphLineText,
} from "./paragraphDetect";

// Display space with scale 1 → units are points. Baseline sits at the run's
// bottom minus a small descent, like real text-derived runs.
function run(
  text: string,
  x: number,
  baselineY: number,
  w: number,
  fontSizePt = 10,
  extra?: Partial<TextRunDisplayBounds>,
): TextRunDisplayBounds {
  return {
    text,
    x,
    y: baselineY - fontSizePt * 0.8,
    w,
    h: fontSizePt,
    baselineY,
    fontSizePt,
    ...extra,
  };
}

// A ragged-right body paragraph: full-ish lines with varying right edges
// (left-aligned) + a short last line, pitch 12.
function bodyParagraph(x = 50, top = 100, width = 300): TextRunDisplayBounds[] {
  return [
    run("first line of the paragraph", x, top, width),
    run("second line of the paragraph", x, top + 12, width * 0.93),
    run("third line of the paragraph", x, top + 24, width * 0.97),
    run("short last.", x, top + 36, width * 0.4),
  ];
}

describe("paragraph detection", () => {
  test("groups same-pitch lines into one left-aligned block", () => {
    const blocks = detectParagraphs(bodyParagraph(), 1);
    expect(blocks.length).toBe(1);
    const block = blocks[0]!;
    expect(block.lines.length).toBe(4);
    expect(block.pitchPx).toBe(12);
    expect(block.align).toBe("left");
    expect(block.confidence).toBe("high");
  });

  test("splits blocks on a hard vertical gap", () => {
    const blocks = detectParagraphs(
      [...bodyParagraph(50, 100), ...bodyParagraph(50, 300)],
      1,
    );
    expect(blocks.length).toBe(2);
    expect(blocks.every((b) => b.lines.length === 4)).toBe(true);
  });

  test("a large-font line becomes its own heading block", () => {
    const heading = run("Heading", 50, 80, 150, 18);
    const blocks = detectParagraphs([heading, ...bodyParagraph(50, 100)], 1);
    expect(blocks.length).toBe(2);
    expect(blocks[0]!.lines.length).toBe(1);
    expect(blocks[0]!.lines[0]!.fontSizePt).toBe(18);
  });

  test("side-by-side columns do not merge", () => {
    const left = bodyParagraph(50, 100, 200);
    const right = bodyParagraph(300, 106, 200); // offset baselines
    const blocks = detectParagraphs([...left, ...right], 1);
    // Each column's lines interleave by y but never share a block.
    for (const block of blocks) {
      const xs = new Set(block.lines.map((line) => Math.round(line.x)));
      expect(xs.size).toBe(1);
    }
    // ...and each column still chains into its own paragraph.
    expect(blocks.map((block) => block.lines.length)).toEqual([4, 4]);
  });

  test("side-by-side columns on shared baselines become one block each", () => {
    // Two-column papers set both columns on the same baseline grid.
    const left = bodyParagraph(50, 100, 200);
    const right = bodyParagraph(300, 100, 200);
    const blocks = detectParagraphs([...left, ...right], 1);
    expect(
      blocks.map((block) => ({
        x: block.rect.x,
        w: block.rect.w,
        lines: block.lines.length,
        confidence: block.confidence,
      })),
    ).toEqual([
      { x: 50, w: 200, lines: 4, confidence: "high" },
      { x: 300, w: 200, lines: 4, confidence: "high" },
    ]);
  });

  test("detects justified text (straight edges, short last line)", () => {
    const x = 50;
    const w = 300;
    const runs = [
      run("aaa bbb ccc", x, 100, w),
      run("ddd eee fff", x, 112, w),
      run("ggg hhh iii", x, 124, w),
      run("end.", x, 136, 60),
    ];
    expect(detectParagraphs(runs, 1)[0]!.align).toBe("justify");
  });

  test("detects centered text", () => {
    const center = 200;
    const runs = [
      run("a centered line", center - 100, 100, 200),
      run("short centered", center - 60, 112, 120),
      run("the longest centered line", center - 130, 124, 260),
    ];
    expect(detectParagraphs(runs, 1)[0]!.align).toBe("center");
  });

  test("a math-font run marks the block low-confidence", () => {
    const runs = bodyParagraph();
    // "48×" scenarios: the × comes from a CMSY symbol font even when the
    // digits around it are ordinary CMR.
    runs[1] = { ...runs[1]!, fontName: "KAXVBH+CMSY10" };
    const blocks = detectParagraphs(runs, 1);
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.confidence).toBe("low");
    expect(blocks[0]!.hasMathFont).toBe(true);
    expect(blocks[0]!.reasons).toContain("contains math-font glyphs");
  });

  test("ordinary text fonts do not trip the math refusal", () => {
    const runs = bodyParagraph().map((r) => ({
      ...r,
      fontName: "ABCDEF+NimbusRomNo9L-Regu",
    }));
    const blocks = detectParagraphs(runs, 1);
    expect(blocks[0]!.confidence).toBe("high");
    expect(blocks[0]!.hasMathFont).toBe(false);
  });

  test("isMathFontName classifies common faces", () => {
    expect(isMathFontName("KAXVBH+CMMI10")).toBe(true);
    expect(isMathFontName("CMEX10")).toBe(true);
    expect(isMathFontName("MSBM7")).toBe(true);
    expect(isMathFontName("LatinModernMath-Regular")).toBe(true);
    expect(isMathFontName("SymbolMT")).toBe(true);
    expect(isMathFontName("KAXVBH+CMR10")).toBe(false);
    expect(isMathFontName("NimbusRomNo9L-ReguItal")).toBe(false);
    expect(isMathFontName("Cambria")).toBe(false);
    expect(isMathFontName(undefined)).toBe(false);
  });

  test("large intra-line gap marks the block low-confidence", () => {
    const runs = [
      run("left cell", 50, 100, 80),
      run("right cell", 220, 100, 80), // 90pt gap ≫ 0.7 × 10pt
      run("left cell2", 50, 112, 80),
      run("right cell2", 220, 112, 80),
    ];
    const blocks = detectParagraphs(runs, 1);
    expect(blocks.some((b) => b.confidence === "low")).toBe(true);
  });

  test("excludes rotated runs (box height far from font size)", () => {
    // A 10pt run whose display box is 200 tall — a rotated margin stamp.
    const rotated = run("arXiv:2603.19312v2", 20, 300, 15, 10, { h: 200 });
    const blocks = detectParagraphs([rotated, ...bodyParagraph()], 1);
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.lines.length).toBe(4);
  });

  test("excludes rotated runs (baseline direction off horizontal)", () => {
    // A 90°-rotated run's width is laid out horizontally, so its box
    // looks like a normal-height page-wide line — only the recorded
    // direction betrays it.
    const stamp = run("arXiv:2603.19312v2 [cs.LG] 24 Mar", 20, 112, 900, 10, {
      dirAngleDeg: 90,
    });
    const blocks = detectParagraphs([stamp, ...bodyParagraph()], 1);
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.lines.length).toBe(4);
    // Same-baseline horizontal runs are untouched by the angle filter.
    expect(blocks[0]!.lines[1]!.runs.length).toBe(1);
  });

  test("ignores runs without an exact baseline", () => {
    const noBaseline: TextRunDisplayBounds = {
      text: "dom fallback",
      x: 50,
      y: 92,
      w: 100,
      h: 10,
    };
    const blocks = detectParagraphs([noBaseline], 1);
    expect(blocks.length).toBe(0);
  });

  test("joins line runs with word-gap spaces, without doubling", () => {
    const runs = [
      run("Hel", 50, 100, 18), // mid-word split: ends at 68
      run("lo", 68.5, 100, 12), // 0.5pt gap → same word
      run("world", 86, 100, 30), // 5.5pt gap ≫ 0.2 × 10pt → word break
      run(" again", 118, 100, 36), // big gap but leading space already there
    ];
    const line = detectParagraphs(runs, 1)[0]!.lines[0]!;
    expect(paragraphLineText(line, 1)).toBe("Hello world again");
  });

  test("indented first line stays in its paragraph", () => {
    const runs = [
      run("    indented opening line", 70, 100, 260),
      run("full second line of paragraph", 50, 112, 300),
      run("full third line of paragraph", 50, 124, 300),
    ];
    const blocks = detectParagraphs(runs, 1);
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.lines.length).toBe(3);
  });
});
