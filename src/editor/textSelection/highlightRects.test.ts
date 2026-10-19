import { describe, expect, test } from "bun:test";
import type { PageModel } from "../../pdf/model/types";
import {
  clientRectsToDisplayRects,
  clipSnappedRectsToGesture,
  displayRectsToPdfRects,
  filterDistantClusters,
  normalizeDomTextOffsetX,
  snapDisplayRectsToTextRuns,
  textOffsetForX,
  textContentToDisplayTextRuns,
} from "./highlightRects";

describe("text selection highlight rect helpers", () => {
  test("clips selected client rects to the page and removes tiny duplicates", () => {
    const root = { left: 100, top: 50, right: 500, bottom: 650 };
    const rects = clientRectsToDisplayRects(
      [
        { left: 110, top: 70, right: 210, bottom: 90 },
        { left: 110, top: 70, right: 210, bottom: 90 },
        { left: 99, top: 49, right: 101, bottom: 51 },
        { left: 470, top: 630, right: 540, bottom: 700 },
      ],
      root,
      400,
      600,
    );

    // h=20 -> vertical trim 8% per side (1.6 -> y+1.6, h-3.2 -> 16.8).
    expect(rects).toEqual([
      { x: 10, y: 21.6, w: 100, h: 16.8 },
      { x: 370, y: 581.6, w: 30, h: 16.8 },
    ]);
  });

  test("merges overlapping rects from the same selected text line", () => {
    const root = { left: 0, top: 0, right: 400, bottom: 600 };
    const rects = clientRectsToDisplayRects(
      [
        { left: 10, top: 20, right: 80, bottom: 40 },
        { left: 75, top: 22, right: 150, bottom: 42 },
      ],
      root,
      400,
      600,
    );

    // Merged band h=22 -> v-trim 1.76.
    expect(rects).toEqual([{ x: 10, y: 21.76, w: 140, h: 18.48 }]);
  });

  test("merges small same-line gaps but keeps wide column gaps separate", () => {
    const root = { left: 0, top: 0, right: 400, bottom: 600 };
    const rects = clientRectsToDisplayRects(
      [
        { left: 10, top: 20, right: 40, bottom: 40 },
        { left: 45, top: 20, right: 90, bottom: 40 },
        { left: 220, top: 20, right: 280, bottom: 40 },
      ],
      root,
      400,
      600,
    );

    expect(rects).toEqual([
      { x: 10, y: 21.6, w: 80, h: 16.8 },
      { x: 220, y: 21.6, w: 60, h: 16.8 },
    ]);
  });

  test("trims the band vertically", () => {
    const root = { left: 0, top: 0, right: 400, bottom: 600 };
    const rects = clientRectsToDisplayRects(
      [{ left: 10, top: 20, right: 110, bottom: 60 }],
      root,
      400,
      600,
    );

    // h=40 -> v-trim 3.2 each side.
    expect(rects).toEqual([{ x: 10, y: 23.2, w: 100, h: 33.6 }]);
  });

  test("converts display selection rects into PDF user-space rects", () => {
    const page: PageModel = {
      id: "p",
      sourceIndex: 0,
      widthPt: 400,
      heightPt: 600,
      rotation: 0,
    };

    expect(
      displayRectsToPdfRects([{ x: 10, y: 20, w: 100, h: 20 }], page, 1),
    ).toEqual([{ x: 10, y: 560, w: 100, h: 20 }]);
  });

  test("snaps a justified line rect near the selected text run bounds", () => {
    const rects = snapDisplayRectsToTextRuns(
      [{ x: 50, y: 100, w: 250, h: 16 }],
      [{ x: 50, y: 96, w: 210, h: 20, text: "justified line" }],
    );

    expect(rects).toEqual([{ x: 50, y: 96, w: 212.4, h: 20 }]);
  });

  test("pads a partial selection width while snapping to text run height", () => {
    const rects = snapDisplayRectsToTextRuns(
      [{ x: 50, y: 100, w: 120, h: 16 }],
      [{ x: 50, y: 96, w: 210, h: 20, text: "justified line" }],
    );

    expect(rects).toEqual([{ x: 50, y: 96, w: 122.4, h: 20 }]);
  });

  test("keeps narrow punctuation from being clipped by line-end capping", () => {
    const rects = snapDisplayRectsToTextRuns(
      [{ x: 50, y: 100, w: 118, h: 16 }],
      [{ x: 50, y: 96, w: 116, h: 20, text: "WorldModel:" }],
    );

    expect(rects).toEqual([{ x: 50, y: 96, w: 118.4, h: 20 }]);
  });

  test("pads both sides of mid-line selections for narrow glyph edges", () => {
    const rects = snapDisplayRectsToTextRuns(
      [{ x: 80, y: 100, w: 36, h: 16 }],
      [{ x: 50, y: 96, w: 180, h: 20, text: "Word with l:t" }],
    );

    expect(rects).toEqual([{ x: 77.6, y: 96, w: 40.8, h: 20 }]);
  });

  test("keeps the original rect when no text run matches the line", () => {
    const rects = snapDisplayRectsToTextRuns(
      [{ x: 50, y: 100, w: 120, h: 16 }],
      [{ x: 50, y: 140, w: 210, h: 20, text: "other line" }],
    );

    expect(rects).toEqual([{ x: 50, y: 100, w: 120, h: 16 }]);
  });

  test("preserves the native selection rect's horizontal bounds for CJK runs", () => {
    // Runtime testing on title-sized CJK exposed both left
    // and right overflow — text-run metrics, the DOM text
    // layer, and glyph ink boundaries don't line up tight enough to
    // drive a numeric padding heuristic. The contract for any
    // CJK-containing line is now: keep the native selection rect's
    // x and w as-is; only y/h come from the text run band. Slight
    // underfill on a true mid-glyph short selection is the accepted
    // tradeoff.

    // Pure CJK, mid-run selection — no horizontal pad on either side.
    const aligned = snapDisplayRectsToTextRuns(
      [{ x: 100, y: 100, w: 60, h: 16 }],
      [{ x: 100, y: 96, w: 240, h: 20, text: "你好世界" }],
    );
    expect(aligned).toEqual([{ x: 100, y: 96, w: 60, h: 20 }]);

    // Text content sometimes splits a CJK line into single-char runs.
    const singleChar = snapDisplayRectsToTextRuns(
      [{ x: 100, y: 100, w: 60, h: 16 }],
      [{ x: 100, y: 96, w: 60, h: 20, text: "你" }],
    );
    expect(singleChar).toEqual([{ x: 100, y: 96, w: 60, h: 20 }]);

    // Whole-run CJK selection lands flush at the run's right edge.
    const runEnd = snapDisplayRectsToTextRuns(
      [{ x: 100, y: 100, w: 240, h: 16 }],
      [{ x: 100, y: 96, w: 240, h: 20, text: "你好世界" }],
    );
    expect(runEnd).toEqual([{ x: 100, y: 96, w: 240, h: 20 }]);

    // Mixed Latin+CJK run from a real title screenshot. textRun.w > selectionRect.w; right pad would have
    // bled past the last selected glyph in the legacy heuristic.
    const mixedMidRun = snapDisplayRectsToTextRuns(
      [{ x: 20, y: 100, w: 398, h: 16 }],
      [{ x: 20, y: 96, w: 426, h: 20, text: "AB 栞示例标题文本" }],
    );
    expect(mixedMidRun).toEqual([{ x: 20, y: 96, w: 398, h: 20 }]);

    // Title-sized run (h=50) — earlier versions hit the 9px pad cap
    // here, so a single-character selection in a title would
    // visibly bleed by 9px on each side. Lock the no-pad contract.
    const titlePure = snapDisplayRectsToTextRuns(
      [{ x: 200, y: 100, w: 80, h: 40 }],
      [{ x: 100, y: 96, w: 320, h: 50, text: "你好世界" }],
    );
    expect(titlePure).toEqual([{ x: 200, y: 96, w: 80, h: 50 }]);

    // Title-sized mixed run — same property.
    const titleMixed = snapDisplayRectsToTextRuns(
      [{ x: 50, y: 100, w: 240, h: 40 }],
      [{ x: 30, y: 96, w: 360, h: 50, text: "AB 栞示例标题文本" }],
    );
    expect(titleMixed).toEqual([{ x: 50, y: 96, w: 240, h: 50 }]);
  });

  test("builds display text run bounds from page text content", () => {
    const page: PageModel = {
      id: "p",
      sourceIndex: 0,
      widthPt: 400,
      heightPt: 600,
      rotation: 0,
    };

    const runs = textContentToDisplayTextRuns(
      {
        items: [
          {
            str: "avoid",
            dir: "ltr",
            transform: [12, 0, 0, 12, 50, 480],
            width: 42,
            height: 12,
            fontName: "g_d0_f1",
            hasEOL: true,
          },
        ],
        styles: {},
        lang: null,
      },
      page,
      2,
    );

    expect(runs).toEqual([
      {
        x: 100,
        y: 220.8,
        w: 84,
        h: 24,
        baselineY: 240,
        dirAngleDeg: 0,
        text: "avoid",
        fontName: "g_d0_f1",
        fontFamily: undefined,
        fontSizePt: 12,
      },
    ]);
  });

  test("normalizes text item positions from non-zero page origins", () => {
    const page: PageModel = {
      id: "p",
      sourceIndex: 0,
      originXPt: 50,
      originYPt: 100,
      widthPt: 400,
      heightPt: 600,
      rotation: 0,
    };

    const runs = textContentToDisplayTextRuns(
      {
        items: [
          {
            str: "avoid",
            dir: "ltr",
            transform: [12, 0, 0, 12, 70, 580],
            width: 42,
            height: 12,
            fontName: "g_d0_f1",
            hasEOL: true,
          },
        ],
        styles: {},
        lang: null,
      },
      page,
      2,
    );

    expect(runs).toEqual([
      {
        x: 40,
        y: 220.8,
        w: 84,
        h: 24,
        baselineY: 240,
        dirAngleDeg: 0,
        text: "avoid",
        fontName: "g_d0_f1",
        fontFamily: undefined,
        fontSizePt: 12,
      },
    ]);
  });

  test("uses resolved PDF font names when available", () => {
    const page: PageModel = {
      id: "p",
      sourceIndex: 0,
      widthPt: 400,
      heightPt: 600,
      rotation: 0,
    };

    const runs = textContentToDisplayTextRuns(
      {
        items: [
          {
            str: "confirms",
            dir: "ltr",
            transform: [10, 0, 0, 10, 50, 480],
            width: 42,
            height: 10,
            fontName: "g_d0_f2",
            hasEOL: false,
          },
        ],
        styles: {
          g_d0_f2: {
            ascent: 0.7,
            descent: -0.2,
            vertical: false,
            fontFamily: "sans-serif",
          },
        },
        lang: null,
      },
      page,
      2,
      new Map([["g_d0_f2", "FUSIJU+NimbusRomNo9L-Regu"]]),
    );

    expect(runs[0]?.fontName).toBe("FUSIJU+NimbusRomNo9L-Regu");
    expect(runs[0]?.fontFamily).toBe("sans-serif");
  });

  test("uses the font's ascent and descent when glyph measurement is unavailable", () => {
    const page: PageModel = {
      id: "p",
      sourceIndex: 0,
      widthPt: 400,
      heightPt: 600,
      rotation: 0,
    };

    const runs = textContentToDisplayTextRuns(
      {
        items: [
          {
            str: "WorldModel",
            dir: "ltr",
            transform: [12, 0, 0, 12, 50, 480],
            width: 84,
            height: 12,
            fontName: "g_d0_f1",
            hasEOL: false,
          },
        ],
        styles: {
          g_d0_f1: {
            ascent: 0.7,
            descent: -0.1,
            vertical: false,
            fontFamily: "serif",
          },
        },
        lang: null,
      },
      page,
      2,
    );

    expect(runs).toEqual([
      {
        x: 100,
        y: 223.2,
        w: 168,
        h: 19.2,
        baselineY: 240,
        dirAngleDeg: 0,
        text: "WorldModel",
        fontName: "g_d0_f1",
        fontFamily: "serif",
        fontSizePt: 12,
      },
    ]);
  });

  test("normalizes stretched DOM character offsets into PDF text-run space", () => {
    const run = {
      x: 100,
      y: 120,
      w: 180,
      h: 18,
      text: "evaluation confirms",
    };

    // Justified arXiv body text can stretch the DOM text-layer span wider
    // than the actual PDF glyph run. Prefix Range rects must be interpreted
    // as ratios inside that stretched span, then mapped back to the real run.
    const domStartX = 100;
    const domEndX = 340;
    const confirmsStartOffset = "evaluation ".length;
    const confirmsEndOffset = run.text.length;
    const confirmsStartDomX =
      domStartX + (confirmsStartOffset / run.text.length) * 240;
    const confirmsEndDomX =
      domStartX + (confirmsEndOffset / run.text.length) * 240;

    expect(
      normalizeDomTextOffsetX(run, domStartX, domEndX, confirmsStartDomX),
    ).toBeCloseTo(100 + (confirmsStartOffset / run.text.length) * 180, 6);
    expect(
      normalizeDomTextOffsetX(run, domStartX, domEndX, confirmsEndDomX),
    ).toBeCloseTo(100 + (confirmsEndOffset / run.text.length) * 180, 6);
  });

  test("keeps a word gesture on the intended word in justified text", () => {
    const run = {
      x: 100,
      y: 120,
      w: 180,
      h: 18,
      text: "evaluation confirms",
    };
    const domStartX = 100;
    const domEndX = 340;
    const textLength = run.text.length;
    const confirmsStartOffset = "evaluation ".length;
    const confirmsEndOffset = textLength;
    const domOffsetForIndex = (index: number) =>
      domStartX + (index / textLength) * (domEndX - domStartX);
    const normalizedOffsets = Array.from({ length: textLength + 1 }, (_, index) =>
      normalizeDomTextOffsetX(run, domStartX, domEndX, domOffsetForIndex(index)),
    );
    const legacyAbsoluteOffsets = Array.from({ length: textLength + 1 }, (_, index) =>
      Math.max(run.x, Math.min(run.x + run.w, domOffsetForIndex(index))),
    );
    const gestureStartX =
      run.x + (confirmsStartOffset / textLength) * run.w + 0.2;
    const gestureEndX =
      run.x + (confirmsEndOffset / textLength) * run.w - 0.2;

    const startOffset = textOffsetForX(
      normalizedOffsets,
      gestureStartX,
      "start",
    );
    const endOffset = textOffsetForX(
      normalizedOffsets,
      gestureEndX,
      "end",
    );
    const legacyStartOffset = textOffsetForX(
      legacyAbsoluteOffsets,
      gestureStartX,
      "start",
    );
    const legacyEndOffset = textOffsetForX(
      legacyAbsoluteOffsets,
      gestureEndX,
      "end",
    );

    expect(run.text.slice(startOffset, endOffset)).toBe("confirms");
    expect(run.text.slice(legacyStartOffset, legacyEndOffset)).toBe("on conf");
  });

  test("includes edge letters when a word gesture lands inside glyph cells", () => {
    const text = "evaluation confirms";
    const offsets = Array.from({ length: text.length + 1 }, (_, index) => index);
    const start = "evaluation ".length;
    const end = text.length;

    const startOffset = textOffsetForX(offsets, start + 0.65, "start");
    const endOffset = textOffsetForX(offsets, end - 0.65, "end");

    expect(text.slice(startOffset, endOffset)).toBe("confirms");
  });

  describe("filterDistantClusters", () => {
    test("passes selections with one cluster through unchanged", () => {
      const rects = [
        { x: 0, y: 200, w: 100, h: 16 },
        { x: 0, y: 220, w: 100, h: 16 },
        { x: 0, y: 240, w: 100, h: 16 },
      ];
      expect(filterDistantClusters(rects, 220)).toEqual(rects);
    });

    test("drops a header cluster when the gesture anchor is in the body", () => {
      // 16px line height; banner sits at y=20 with a 100px gap to body.
      const banner = { x: 0, y: 20, w: 100, h: 16 };
      const body = [
        { x: 0, y: 220, w: 100, h: 16 },
        { x: 0, y: 240, w: 100, h: 16 },
        { x: 0, y: 260, w: 100, h: 16 },
      ];
      // Anchor in the middle of the body cluster.
      expect(filterDistantClusters([banner, ...body], 240)).toEqual(body);
    });

    test("keeps distant clusters crossed by a deliberate vertical gesture", () => {
      const beforeImage = { x: 0, y: 100, w: 180, h: 16 };
      const imageOcr = { x: 40, y: 220, w: 120, h: 16 };
      const afterImage = { x: 0, y: 340, w: 180, h: 16 };

      expect(
        filterDistantClusters(
          [beforeImage, imageOcr, afterImage],
          228,
          { minY: 108, maxY: 348 },
        ),
      ).toEqual([beforeImage, imageOcr, afterImage]);
    });

    test("drops clusters outside a short gesture span", () => {
      const banner = { x: 0, y: 20, w: 100, h: 16 };
      const body = [
        { x: 0, y: 220, w: 100, h: 16 },
        { x: 0, y: 240, w: 100, h: 16 },
      ];

      expect(
        filterDistantClusters(
          [banner, ...body],
          230,
          { minY: 222, maxY: 248 },
        ),
      ).toEqual(body);
    });

    test("drops a footer cluster when the gesture anchor is in the body", () => {
      const body = [
        { x: 0, y: 100, w: 100, h: 16 },
        { x: 0, y: 120, w: 100, h: 16 },
      ];
      const footer = { x: 0, y: 580, w: 100, h: 16 };
      expect(filterDistantClusters([...body, footer], 110)).toEqual(body);
    });

    test("keeps the header cluster if that's where the gesture anchor sits", () => {
      const header = [{ x: 0, y: 20, w: 100, h: 16 }];
      const body = [
        { x: 0, y: 220, w: 100, h: 16 },
        { x: 0, y: 240, w: 100, h: 16 },
      ];
      expect(filterDistantClusters([...header, ...body], 22)).toEqual(header);
    });

    test("merges consecutive lines whose gap is < 2× line height", () => {
      // Adjacent paragraphs separated by ~1 line of whitespace should
      // stay together — that is normal paragraph spacing, not a banner.
      const rects = [
        { x: 0, y: 100, w: 100, h: 16 },
        { x: 0, y: 122, w: 100, h: 16 }, // gap=6px (< 32px threshold)
        { x: 0, y: 156, w: 100, h: 16 }, // gap=18 (< 32)
        { x: 0, y: 178, w: 100, h: 16 }, // gap=6
      ];
      expect(filterDistantClusters(rects, 140)).toEqual(rects);
    });

    test("falls back to the median Y when the gesture anchor is null", () => {
      const top = [{ x: 0, y: 50, w: 100, h: 16 }];
      const middle = [
        { x: 0, y: 200, w: 100, h: 16 },
        { x: 0, y: 220, w: 100, h: 16 },
        { x: 0, y: 240, w: 100, h: 16 },
      ];
      // Median of all five Ys (sorted: 50, 200, 220, 240) → 220 in the
      // middle cluster, so the standalone top is dropped.
      expect(filterDistantClusters([...top, ...middle], null)).toEqual(middle);
    });

    test("returns the input unchanged when there is at most one rect", () => {
      expect(filterDistantClusters([], 100)).toEqual([]);
      const single = [{ x: 0, y: 100, w: 100, h: 16 }];
      expect(filterDistantClusters(single, 100)).toEqual(single);
    });
  });

  describe("clipSnappedRectsToGesture", () => {
    const cjkRun = { x: 173.82, y: 462.93, w: 792.76, h: 86.06, text: "AB 栞示例标题文本" };
    const latinRun = { x: 100, y: 100, w: 240, h: 20, text: "Hello world" };

    test("soft-clips when over-extension is significant (>= 20% of raw width)", () => {
      // A title case from runtime data: overRatio = 72.26/340.23 = 21.3%.
      // Clip kicks in but with a margin so the highlight isn't
      // hard-snapped to the gesture point. margin = clamp(86.06*0.06, 3, 8) = ~5.16.
      const snapped = [{ x: 173.82, y: 462.93, w: 340.23, h: 86.06 }];
      const result = clipSnappedRectsToGesture(
        snapped,
        [cjkRun],
        { x: 202.59 },
        { x: 470.56 },
      );
      const r = result[0]!;
      // left = max(173.82, 202.59 - 5.16) = 197.43
      expect(r.x).toBeCloseTo(197.43, 1);
      // right = min(514.05, 470.56 + 5.16) = 475.72
      expect(r.x + r.w).toBeCloseTo(475.72, 1);
      expect(r.y).toBe(462.93);
      expect(r.h).toBe(86.06);
    });

    test("does not clip when over-extension/raw is below 20%", () => {
      // Another runtime title: overRatio = 42.79/280.27 = 15.3 %.
      // The earlier strict-clip implementation chopped both edges
      // and the user reported "left and right both missing". The
      // gate keeps the raw rect intact at this ratio.
      const snapped = [{ x: 143.09, y: 376.15, w: 280.27, h: 70.94 }];
      const result = clipSnappedRectsToGesture(
        snapped,
        [cjkRun],
        { x: 159.34 },
        { x: 396.81 },
      );
      expect(result).toEqual(snapped);
    });

    test("does not clip body-text CJK at low over-extension ratios (4.7%)", () => {
      // Body case where over-extension/raw ≈ 4.7% — well below
      // the gate. Body-text DOM Range over-extension is small
      // enough that any clip would visibly under-fill.
      const snapped = [{ x: 141.97, y: 119.51, w: 174.23, h: 17.31 }];
      const bodyRun = {
        x: 142.11,
        y: 121.09,
        w: 486.4,
        h: 17.31,
        text: "阅读完点击【页面列表】【文本搜索】，重新浏览，查漏补缺。",
      };
      const result = clipSnappedRectsToGesture(
        snapped,
        [bodyRun],
        { x: 145.9 },
        { x: 311.89 },
      );
      expect(result).toEqual(snapped);
    });

    test("handles right-to-left drag using min/max", () => {
      const snapped = [{ x: 173.82, y: 462.93, w: 340.23, h: 86.06 }];
      const ltr = clipSnappedRectsToGesture(
        snapped,
        [cjkRun],
        { x: 202.59 },
        { x: 470.56 },
      );
      const rtl = clipSnappedRectsToGesture(
        snapped,
        [cjkRun],
        { x: 470.56 },
        { x: 202.59 },
      );
      expect(rtl).toEqual(ltr);
    });

    test("does not clip Latin-only runs (they don't show the advance/ink mismatch)", () => {
      // Latin selection whose over-extension would otherwise cross 20%.
      const snapped = [{ x: 100, y: 100, w: 240, h: 20 }];
      const result = clipSnappedRectsToGesture(
        snapped,
        [latinRun],
        { x: 150 },
        { x: 250 },
      );
      expect(result).toEqual(snapped);
    });

    test("does not clip multi-line selections (clip x-range doesn't apply to wrapped lines)", () => {
      // A single Range covering two visual lines produces two rects;
      // one gesture x-range can't apply to both without chopping
      // the second line at the first line's right edge.
      const snapped = [
        { x: 100, y: 100, w: 200, h: 20 },
        { x: 100, y: 130, w: 80, h: 20 },
      ];
      const result = clipSnappedRectsToGesture(
        snapped,
        [cjkRun],
        { x: 150 },
        { x: 220 },
      );
      expect(result).toEqual(snapped);
    });

    test("returns input unchanged when there is no gesture (e.g. keyboard selection)", () => {
      const snapped = [{ x: 173.82, y: 462.93, w: 340.23, h: 86.06 }];
      expect(clipSnappedRectsToGesture(snapped, [cjkRun], null, null)).toEqual(
        snapped,
      );
    });

    test("returns input unchanged when gesture has zero width (collapsed click)", () => {
      const snapped = [{ x: 173.82, y: 462.93, w: 340.23, h: 86.06 }];
      const result = clipSnappedRectsToGesture(
        snapped,
        [cjkRun],
        { x: 200 },
        { x: 200 },
      );
      expect(result).toEqual(snapped);
    });

    test("drops the rect when an over-threshold clip would leave nothing visible", () => {
      // rect spans 100..200; gesture sits well past it (500..520).
      // overRatio = (100-20)/100 = 0.8, clip applies, but the
      // intersection with the gesture (plus margin) lies outside
      // [100, 200], so the post-clip width goes below MIN_TEXT_RECT_PX
      // and the whole rect drops.
      const snapped = [{ x: 100, y: 100, w: 100, h: 20 }];
      const result = clipSnappedRectsToGesture(
        snapped,
        [cjkRun],
        { x: 500 },
        { x: 520 },
      );
      expect(result).toEqual([]);
    });
  });
});
