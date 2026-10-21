// Paragraph/block detection over text runs — the foundation of
// paragraph-level original-text editing (docs/PLAN-PARAGRAPH-CONTENT-TEXT-
// 2026-07.md). Pure geometry: runs → lines → blocks, using the signals and
// thresholds from docs/RESEARCH-PARAGRAPH-EDIT-2026-07.md (adapted from
// PDFBox PDFTextStripper / pdfminer LAParams / MuPDF stext).
//
// Design contract: detect HIGH-CONFIDENCE blocks only. A block that trips
// any anomaly signal is still returned but marked { confidence: "low" } with
// the reasons recorded — the edit layer must refuse to edit those instead of
// guessing. Runs without an exact baseline (DOM-fallback geometry) are
// ignored entirely; an estimated baseline would poison every downstream
// consumer.

import type { DisplayRect, TextRunDisplayBounds } from "./highlightRects";

// Thresholds in POINTS (multiplied by the display scale internally).
// Sources: RESEARCH doc "Suggested v1 thresholds".
export const PARAGRAPH_DETECT = {
  // Same-line: |baseline delta| <= max(floorPt, ratio × median font size).
  sameLineFloorPt: 1.5,
  sameLineFontRatio: 0.25,
  // Block continuation: gap within [min, max] × the block's median pitch.
  pitchBandMin: 0.75,
  pitchBandMax: 1.45,
  // Hard vertical break: gap > max(hardBreakFontRatio × font size,
  // hardBreakPitchRatio × median pitch).
  hardBreakFontRatio: 2.0,
  hardBreakPitchRatio: 1.5,
  // Continuation lines must overlap horizontally by this share of the
  // narrower line.
  xOverlapRatio: 0.35,
  // Font-size continuity within a block (relative change vs block median).
  fontSizeContinuity: 0.2,
  // A line this much larger than the page body median is a heading.
  headingFontRatio: 1.25,
  // Intra-line gap larger than this × font size suggests columns/tables:
  // the line splits there into segments that chain into blocks separately.
  intraLineGapFontRatio: 0.7,
  // A block holding such segments is a text column only while its lines
  // (all but the last) are at least this × font size wide; narrower ones
  // are table cells.
  columnLineMinFontRatio: 12,
  // ...and only with wrapping to show for it: this many lines, the body
  // ones ending within this × font size of the block's right edge. Wide
  // table cells stacked row on row show neither.
  columnMinLines: 3,
  columnRightEdgeFontRatio: 2,
  // Alignment: edge stability = MAD <= max(edgeStabilityPt, edgeStabilityWidthRatio × block width).
  edgeStabilityPt: 2,
  edgeStabilityWidthRatio: 0.01,
  // Lines narrower than this share of the median width are excluded from
  // alignment voting (short/last lines).
  alignmentLineWidthRatio: 0.65,
  // Justify additionally requires the final line to be narrower than this
  // share of the block width.
  justifyFinalLineRatio: 0.9,
  // A run whose box height deviates from its font size by more than this
  // ratio is rotated/skewed text (e.g. an arXiv margin stamp): its baseline
  // is meaningless in page-horizontal terms, so it is excluded up front.
  runHeightFontTolerance: 0.4,
  // Runs whose baseline advance direction is off horizontal by more than
  // this many degrees are rotated text; their display box is laid out as if
  // horizontal, so grouping them would fabricate page-wide "lines".
  maxRunAngleDeg: 5,
} as const;

export type DetectedLine = {
  runs: TextRunDisplayBounds[];
  // Display-space geometry of the line's union box.
  x: number;
  right: number;
  width: number;
  top: number;
  bottom: number;
  // Exact baseline (median of the runs' baselines) and median font size.
  baselineY: number;
  fontSizePt: number;
  // Split off other text on the same baseline by a large gap.
  columnSplit?: boolean;
};

export type ParagraphAlign = "left" | "center" | "right" | "justify" | "unknown";

export type DetectedParagraph = {
  lines: DetectedLine[];
  rect: DisplayRect;
  // Median baseline pitch in display units; null for single-line blocks.
  pitchPx: number | null;
  align: ParagraphAlign;
  confidence: "high" | "low";
  // Human-readable anomaly notes (debug overlay + edit-layer refusal).
  reasons: string[];
  // Machine-readable refusal cause so the edit layer can explain WHY a
  // click was refused (the reasons strings are debug-only English).
  hasMathFont: boolean;
};

// TeX math faces (CMMI/CMSY/CMEX + AMS/script/fraktur companions) and
// anything self-describing as Math or Symbol. A paragraph containing such
// runs is refused: the flattened single-style edit destroys the formula on
// screen, and no text encoder can redraw those glyph streams on export.
const MATH_FONT_BASE =
  /^(?:cmmi|cmsy|cmex|cmbsy|cmmib|msam|msbm|eufm|eufb|eusm|eusb|rsfs|stmary|wasy|lasy)\d*$/;

export function isMathFontName(name: string | undefined): boolean {
  if (!name) return false;
  // Strip the "ABCDEF+" subset-tag prefix embedded fonts carry.
  const base = name.replace(/^[A-Z]{6}\+/, "").toLowerCase();
  if (MATH_FONT_BASE.test(base)) return true;
  return /math|symbol/.test(base);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

// Median absolute deviation — robust edge-stability measure.
function mad(values: number[]): number {
  const m = median(values);
  return median(values.map((value) => Math.abs(value - m)));
}

function groupRunsIntoLines(
  runs: TextRunDisplayBounds[],
  scale: number,
): DetectedLine[] {
  const usable = runs.filter((run) => {
    if (
      typeof run.baselineY !== "number" ||
      !Number.isFinite(run.baselineY) ||
      run.w <= 0 ||
      run.text.trim() === ""
    ) {
      return false;
    }
    // Rotated text: the run box is computed as if horizontal, so a 90°
    // margin stamp becomes a page-wide pseudo-line. Exclude by baseline
    // direction when the extractor recorded it.
    if (
      typeof run.dirAngleDeg === "number" &&
      Math.abs(run.dirAngleDeg) > PARAGRAPH_DETECT.maxRunAngleDeg
    ) {
      return false;
    }
    // Belt-and-braces: skewed text whose display box height no longer
    // matches the font size (a horizontal run's box is ~fontSize tall).
    // Grouping such runs by baseline produces nonsense lines — drop them.
    if (typeof run.fontSizePt === "number" && run.fontSizePt > 0) {
      const expected = run.fontSizePt * scale;
      if (
        Math.abs(run.h - expected) >
        PARAGRAPH_DETECT.runHeightFontTolerance * expected
      ) {
        return false;
      }
    }
    return true;
  });
  if (usable.length === 0) return [];
  const fontSizes = usable
    .map((run) => run.fontSizePt)
    .filter((size): size is number => typeof size === "number" && size > 0);
  const medianFontPt = fontSizes.length > 0 ? median(fontSizes) : 10;
  const tolerance =
    Math.max(
      PARAGRAPH_DETECT.sameLineFloorPt,
      PARAGRAPH_DETECT.sameLineFontRatio * medianFontPt,
    ) * scale;

  const sorted = [...usable].sort((a, b) => a.baselineY! - b.baselineY!);
  const groups: TextRunDisplayBounds[][] = [];
  for (const run of sorted) {
    const current = groups[groups.length - 1];
    if (
      current &&
      Math.abs(run.baselineY! - current[0]!.baselineY!) <= tolerance
    ) {
      current.push(run);
    } else {
      groups.push([run]);
    }
  }
  return groups.flatMap((group) => {
    const inLine = [...group].sort((a, b) => a.x - b.x);
    const groupSizes = inLine
      .map((run) => run.fontSizePt)
      .filter((size): size is number => typeof size === "number" && size > 0);
    const limit =
      PARAGRAPH_DETECT.intraLineGapFontRatio *
      (groupSizes.length > 0 ? median(groupSizes) : medianFontPt) *
      scale;
    const segments: TextRunDisplayBounds[][] = [];
    let segmentRight = Number.NEGATIVE_INFINITY;
    for (const run of inLine) {
      const current = segments[segments.length - 1];
      if (current && run.x - segmentRight <= limit) {
        current.push(run);
        segmentRight = Math.max(segmentRight, run.x + run.w);
      } else {
        segments.push([run]);
        segmentRight = run.x + run.w;
      }
    }
    return segments.map((segment) =>
      lineOf(segment, medianFontPt, segments.length > 1),
    );
  });
}

function lineOf(
  inLine: TextRunDisplayBounds[],
  medianFontPt: number,
  columnSplit: boolean,
): DetectedLine {
  const x = Math.min(...inLine.map((run) => run.x));
  const right = Math.max(...inLine.map((run) => run.x + run.w));
  const top = Math.min(...inLine.map((run) => run.y));
  const bottom = Math.max(...inLine.map((run) => run.y + run.h));
  const sizes = inLine
    .map((run) => run.fontSizePt)
    .filter((size): size is number => typeof size === "number" && size > 0);
  return {
    runs: inLine,
    x,
    right,
    width: right - x,
    top,
    bottom,
    baselineY: median(inLine.map((run) => run.baselineY!)),
    fontSizePt: sizes.length > 0 ? median(sizes) : medianFontPt,
    ...(columnSplit ? { columnSplit } : {}),
  };
}

function xOverlap(a: DetectedLine, b: DetectedLine): number {
  return Math.min(a.right, b.right) - Math.max(a.x, b.x);
}

// Split-off segments make a text column only when they wrap: several
// column-width lines filled to one right edge. Anything less may be a
// table column, whose cells are separate texts.
function splitSegmentsAreTableCells(lines: DetectedLine[], scale: number): boolean {
  if (!lines.some((line) => line.columnSplit)) return false;
  if (lines.length < PARAGRAPH_DETECT.columnMinLines) return true;
  const bodyLines = lines.slice(0, -1);
  const right = Math.max(...bodyLines.map((line) => line.right));
  return bodyLines.some(
    (line) =>
      line.width <
        PARAGRAPH_DETECT.columnLineMinFontRatio * line.fontSizePt * scale ||
      right - line.right >
        PARAGRAPH_DETECT.columnRightEdgeFontRatio * line.fontSizePt * scale,
  );
}

function detectAlign(
  block: DetectedLine[],
  rect: DisplayRect,
  scale: number,
): ParagraphAlign {
  if (block.length < 2) return "unknown";
  const widths = block.map((line) => line.width);
  const medianWidth = median(widths);
  const voters = block.filter(
    (line) => line.width >= PARAGRAPH_DETECT.alignmentLineWidthRatio * medianWidth,
  );
  if (voters.length < 2) return "unknown";
  const stability = Math.max(
    PARAGRAPH_DETECT.edgeStabilityPt * scale,
    PARAGRAPH_DETECT.edgeStabilityWidthRatio * rect.w,
  );
  const leftStable = mad(voters.map((line) => line.x)) <= stability;
  const rightStable = mad(voters.map((line) => line.right)) <= stability;
  const centerStable =
    mad(voters.map((line) => line.x + line.width / 2)) <= stability;
  if (leftStable && rightStable) {
    // Classic justify signature: straight left AND right edges with a short
    // final line. A perfectly rectangular block (full last line) is
    // ambiguous — call it left, which is also the plan's reflow default.
    const last = block[block.length - 1]!;
    return last.width < PARAGRAPH_DETECT.justifyFinalLineRatio * rect.w
      ? "justify"
      : "left";
  }
  if (leftStable) return "left";
  if (rightStable) return "right";
  if (centerStable) return "center";
  return "unknown";
}

function blockRect(lines: DetectedLine[]): DisplayRect {
  const x = Math.min(...lines.map((line) => line.x));
  const right = Math.max(...lines.map((line) => line.right));
  const top = Math.min(...lines.map((line) => line.top));
  const bottom = Math.max(...lines.map((line) => line.bottom));
  return { x, y: top, w: right - x, h: bottom - top };
}

function finalizeBlock(
  lines: DetectedLine[],
  scale: number,
  reasons: string[],
): DetectedParagraph {
  const rect = blockRect(lines);
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    gaps.push(lines[i]!.baselineY - lines[i - 1]!.baselineY);
  }
  const pitchPx = gaps.length > 0 ? median(gaps) : null;
  if (splitSegmentsAreTableCells(lines, scale)) {
    reasons.push("large intra-line gap (columns/table?)");
  }
  const hasMathFont = lines.some((line) =>
    line.runs.some((run) => isMathFontName(run.fontName)),
  );
  if (hasMathFont) reasons.push("contains math-font glyphs");
  const align = detectAlign(lines, rect, scale);
  if (align === "unknown" && lines.length > 1) {
    reasons.push("no stable alignment edge");
  }
  return {
    lines,
    rect,
    pitchPx,
    align,
    confidence: reasons.length === 0 ? "high" : "low",
    reasons,
    hasMathFont,
  };
}

/** A detected line's union box as a display-space rect. */
export function lineDisplayRect(line: DetectedLine): DisplayRect {
  return {
    x: line.x,
    y: line.top,
    w: line.width,
    h: line.bottom - line.top,
  };
}

// Join a detected line's runs into text. Text items are split arbitrarily
// (often mid-word) and word spaces are sometimes geometry rather than space
// glyphs — insert one when the gap between adjacent runs reads as a word
// break (> ~0.2em, the typical word space being ~0.25em) and neither side
// already provides whitespace.
export function paragraphLineText(line: DetectedLine, scale: number): string {
  let out = "";
  for (let i = 0; i < line.runs.length; i += 1) {
    const run = line.runs[i]!;
    if (i > 0) {
      const prev = line.runs[i - 1]!;
      const gap = run.x - (prev.x + prev.w);
      if (
        gap > 0.2 * line.fontSizePt * scale &&
        !/\s$/.test(out) &&
        !/^\s/.test(run.text)
      ) {
        out += " ";
      }
    }
    out += run.text;
  }
  return out;
}

export function detectParagraphs(
  runs: TextRunDisplayBounds[],
  scale: number,
): DetectedParagraph[] {
  const lines = groupRunsIntoLines(runs, scale);
  if (lines.length === 0) return [];
  const bodyMedianFontPt = median(lines.map((line) => line.fontSizePt));

  // Columns interleave in baseline order, so several blocks stay open at
  // once; a line continues the open block right above it (horizontal
  // overlap), and passing below any other open block closes that one.
  type OpenBlock = { lines: DetectedLine[]; reasons: string[]; order: number };
  const blocks: Array<{ paragraph: DetectedParagraph; order: number }> = [];
  let open: OpenBlock[] = [];
  let opened = 0;
  const close = (block: OpenBlock) => {
    open = open.filter((candidate) => candidate !== block);
    blocks.push({
      paragraph: finalizeBlock(block.lines, scale, block.reasons),
      order: block.order,
    });
  };
  const start = (line: DetectedLine, isHeading: boolean) => {
    const block = { lines: [line], reasons: [], order: opened };
    opened += 1;
    open.push(block);
    if (isHeading) close(block); // headings are single-line blocks
  };
  const isHeadingLine = (line: DetectedLine) =>
    line.fontSizePt > PARAGRAPH_DETECT.headingFontRatio * bodyMedianFontPt;

  for (const line of lines) {
    const isHeading = isHeadingLine(line);
    const above = open.filter((block) => {
      const prev = block.lines[block.lines.length - 1]!;
      return (
        xOverlap(prev, line) >=
        PARAGRAPH_DETECT.xOverlapRatio * Math.min(prev.width, line.width)
      );
    });
    // The nearest block above continues; any other one ends here.
    const block = above.reduce<OpenBlock | null>(
      (best, candidate) =>
        best === null ||
        candidate.lines[candidate.lines.length - 1]!.baselineY >
          best.lines[best.lines.length - 1]!.baselineY
          ? candidate
          : best,
      null,
    );
    for (const other of above) if (other !== block) close(other);
    if (!block) {
      start(line, isHeading);
      continue;
    }
    const current = block.lines;
    const prev = current[current.length - 1]!;
    const prevIsHeading = isHeadingLine(prev);
    const gap = line.baselineY - prev.baselineY;
    const gaps = current
      .slice(1)
      .map((l, i) => l.baselineY - current[i]!.baselineY);
    const pitch = gaps.length > 0 ? median(gaps) : null;

    const hardBreak =
      gap >
      Math.max(
        PARAGRAPH_DETECT.hardBreakFontRatio * line.fontSizePt * scale,
        pitch !== null ? PARAGRAPH_DETECT.hardBreakPitchRatio * pitch : 0,
      );
    const pitchBreak =
      pitch !== null &&
      (gap < PARAGRAPH_DETECT.pitchBandMin * pitch ||
        gap > PARAGRAPH_DETECT.pitchBandMax * pitch);
    const blockMedianFontPt = median(current.map((l) => l.fontSizePt));
    const fontBreak =
      Math.abs(line.fontSizePt - blockMedianFontPt) / blockMedianFontPt >
      PARAGRAPH_DETECT.fontSizeContinuity;

    if (isHeading || prevIsHeading || hardBreak || pitchBreak || fontBreak) {
      close(block);
      start(line, isHeading);
      continue;
    }
    current.push(line);
  }
  for (const block of [...open]) close(block);
  return blocks
    .sort((left, right) => left.order - right.order)
    .map((entry) => entry.paragraph);
}
