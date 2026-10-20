import type { PdfPoint } from "../model/types";
import { deterministicTextVerticalMetrics } from "../geometry/textMetrics";
import type {
  PdfTextGlyph,
  PdfTextItem,
  PdfTextStyle,
} from "./text";
import type { PdfPageText } from "./types";

/**
 * One glyph as shiori-core reads it through PDFium, PDF user space: the
 * shape every binding reports (Tauri IPC, wasm, the CLI's Node addon).
 */
export type PdfiumGlyph = {
  text: string;
  /** Baseline start. */
  origin: [number, number];
  /** Advance end. */
  end: [number, number];
  fontSize: number;
  /** Counter-clockwise radians of the baseline. */
  angle: number;
  /** A space or line break PDFium inferred; nothing is drawn. */
  generated: boolean;
  fontName: string;
  /** PDF font descriptor flags. */
  fontFlags: number;
  /** Page units at this glyph's size; descent is negative. */
  ascent: number;
  descent: number;
  /**
   * A line-end hyphen PDFium recognised as hyphenation (`text` is "-"),
   * where a binding reports it; the CLI's Node addon does.
   */
  hyphen?: boolean;
};

/** A glyph as the Node addon reports it: with its box and hyphenation. */
export type PdfiumGlyphWithBox = PdfiumGlyph & {
  /** [left, bottom, right, top]: the advance box united with the glyph's ink. */
  loose: [number, number, number, number];
  hyphen: boolean;
};

// A run continues while the next glyph starts no further back than this
// (kerning pulls glyphs into each other) and no further ahead (a wider gap
// is a column or a tab, where the text layer's span must not stretch).
// Shares of the font size; pdf.js's NEGATIVE_SPACE_FACTOR and
// SPACE_IN_FLOW_MAX_FACTOR, so runs break where they did under pdf.js.
const MAX_OVERLAP_EM = 0.2;
const MAX_GAP_EM = 0.6;
// The glyph mapping (mapTextContentGlyphs) accepts a glyph 0.05 em off its
// run's baseline; stay inside that.
const BASELINE_EM = 0.04;
const ANGLE_EPSILON = 1e-3;
const FIXED_PITCH = 1;
const SERIF = 2;

type Run = {
  style: string;
  fontSize: number;
  angle: number;
  dir: PdfPoint;
  origin: PdfPoint;
  str: string;
  /** Advance end of the last drawn glyph, along the baseline from origin. */
  width: number;
  /** A PDFium space seen since the last drawn glyph. */
  pendingSpace: boolean;
  /** The run's text item once it has been emitted; a resumed run updates it. */
  item: PdfTextItem | null;
  /** The drawn glyphs in `str`, in reading order. */
  glyphs: PdfItemGlyph[];
  /** Grows leftward: each glyph ends where the run starts, so `origin`
   * moves to it and `str` stays in reading order. */
  rtl: boolean;
};

/** A drawn glyph of a text item: its UTF-16 range in `str`, and its advance
 * from origin to end in PDF user space. */
export type PdfItemGlyph = { start: number; endOffset: number; origin: PdfPoint; end: PdfPoint };

// Keyed by the item object, so it reaches every reader of this page text
// (anchors, CLI search, Live API) without widening the pdf.js item shape.
const itemGlyphs = new WeakMap<PdfTextItem, readonly PdfItemGlyph[]>();

/** The glyphs PDFium drew for an item built here; undefined for any other item. */
export function pdfiumItemGlyphs(item: PdfTextItem): readonly PdfItemGlyph[] | undefined {
  return itemGlyphs.get(item);
}

// PDFium orders a page's characters by line and can put text that crosses a
// line (a diagonal watermark) in the middle of it, splitting a word in two
// with inferred line breaks. A glyph that picks up exactly where one of the
// last few runs stopped continues that run instead, provided what came in
// between lies off that run's baseline: text on the same baseline (a
// semicolon in another font) sits in its reading order already.
const RESUMABLE_RUNS = 4;

/**
 * Builds a page's text for the reading layer from PDFium's glyphs: the text
 * items the text layer, selection and semantic copy consume (the shape pdf.js
 * hands over), and each drawn glyph's advance cell. Consecutive glyphs share
 * an item while they keep their font, size and baseline and follow on
 * without a gap; a line break PDFium inferred ends the item's line.
 *
 * PDFium reports neither writing mode nor marked content, so vertical text
 * lays out as rotated horizontal runs and no /ActualText spans are emitted
 * (PDFium has already substituted the actual text into the glyphs).
 */
export function pageTextFromPdfiumGlyphs(
  glyphs: readonly PdfiumGlyph[],
  lang: string | null,
): PdfPageText {
  const builder = new PageTextBuilder();
  for (const glyph of glyphs) {
    if (!glyph.generated) {
      builder.glyph(glyph);
      // PDFium joins a word hyphenated across lines with no break between;
      // the line still ends at the hyphen, as pdf.js reports it, so the
      // reading layer rejoins the word.
      if (glyph.hyphen) builder.lineBreak();
    } else if (/[\r\n]/u.test(glyph.text)) builder.lineBreak();
    else if (/\s/u.test(glyph.text)) builder.space();
  }
  return builder.finish(lang);
}

class PageTextBuilder {
  #items: PdfTextItem[] = [];
  #styles: Record<string, PdfTextStyle> = {};
  #styleKeys = new Map<string, string>();
  #fontNames = new Map<string, string>();
  #cells: PdfTextGlyph[] = [];
  #run: Run | null = null;
  #recent: Run[] = [];
  /** A space PDFium inferred after a run ended: where it starts, in that run. */
  #looseSpace: { at: PdfPoint; run: Run } | null = null;

  glyph(glyph: PdfiumGlyph): void {
    const size = glyph.fontSize > 0 ? glyph.fontSize : 1;
    const style = this.#styleOf(glyph, size);
    const origin = { x: glyph.origin[0], y: glyph.origin[1] };
    const end = { x: glyph.end[0], y: glyph.end[1] };
    let run = this.#run;
    let way = run ? continues(run, style, size, glyph, origin, end) : null;
    if (run && !way) {
      this.#flush(false);
      run = null;
    }
    if (!run) {
      const resumed = this.#recent.find(
        (recent, i) =>
          continues(recent, style, size, glyph, origin, end) &&
          this.#recent.slice(0, i).every((between) => !sameBaseline(recent, between)),
      );
      if (resumed) {
        way = continues(resumed, style, size, glyph, origin, end);
        this.#recent = this.#recent.filter((recent) => recent !== resumed);
        this.#looseSpace = null;
        run = resumed;
        this.#run = run;
      }
    }
    if (!run) {
      if (this.#looseSpace) {
        const { run: before, at } = this.#looseSpace;
        this.#items.push(before.rtl ? spaceItem(before, end, at) : spaceItem(before, at, origin));
        this.#looseSpace = null;
      }
      run = {
        style,
        fontSize: size,
        angle: glyph.angle,
        dir: { x: Math.cos(glyph.angle), y: Math.sin(glyph.angle) },
        origin,
        str: "",
        width: 0,
        pendingSpace: false,
        item: null,
        glyphs: [],
        rtl: false,
      };
      this.#run = run;
    } else if (way === "leftward") {
      // The run now starts at this glyph.
      run.rtl = true;
      run.width -= offsetAlong(run, origin);
      run.origin = origin;
    }
    if (run.pendingSpace && !/\s$/u.test(run.str)) run.str += " ";
    run.pendingSpace = false;
    run.glyphs.push({ start: run.str.length, endOffset: run.str.length + glyph.text.length, origin, end });
    run.str += glyph.text;
    run.width = Math.max(run.width, offsetAlong(run, origin), offsetAlong(run, end));
    this.#cells.push(cellOf(glyph, style, origin, end, run.dir, size));
  }

  space(): void {
    if (this.#run) this.#run.pendingSpace = true;
  }

  lineBreak(): void {
    this.#flush(true);
    this.#looseSpace = null;
  }

  finish(lang: string | null): PdfPageText {
    this.#flush(false);
    return {
      content: { items: this.#items, styles: this.#styles, lang },
      glyphs: this.#cells,
      fontNames: this.#fontNames,
      faceFamilies: new Map(),
    };
  }

  #flush(hasEOL: boolean): void {
    const run = this.#run;
    if (run) {
      if (run.item) {
        Object.assign(run.item, itemOf(run, hasEOL));
      } else {
        run.item = itemOf(run, hasEOL);
        itemGlyphs.set(run.item, run.glyphs);
        this.#items.push(run.item);
      }
      this.#recent = [run, ...this.#recent].slice(0, RESUMABLE_RUNS);
      if (!hasEOL && run.pendingSpace) {
        this.#looseSpace = { at: run.rtl ? run.origin : along(run, run.width), run };
      }
    } else if (hasEOL) {
      const last = this.#items[this.#items.length - 1];
      if (last) last.hasEOL = true;
    }
    this.#run = null;
  }

  #styleOf(glyph: PdfiumGlyph, size: number): string {
    const ascent = glyph.ascent / size;
    const descent = glyph.descent / size;
    const identity = [glyph.fontName, glyph.fontFlags, ascent.toFixed(4), descent.toFixed(4)].join("\u0000");
    let key = this.#styleKeys.get(identity);
    if (key === undefined) {
      key = `f${this.#styleKeys.size}`;
      this.#styleKeys.set(identity, key);
      this.#styles[key] = {
        fontFamily:
          glyph.fontFlags & FIXED_PITCH ? "monospace" : glyph.fontFlags & SERIF ? "serif" : "sans-serif",
        ascent,
        descent,
        vertical: false,
      };
      if (glyph.fontName) this.#fontNames.set(key, glyph.fontName);
    }
    return key;
  }
}

// Letters of the right-to-left scripts; a run turns right-to-left only on
// two of them in a row, so a neutral or Latin glyph never flips it.
const RTL_LETTER = /^[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;

function continues(
  run: Run,
  style: string,
  size: number,
  glyph: PdfiumGlyph,
  origin: PdfPoint,
  end: PdfPoint,
): "forward" | "leftward" | null {
  const offset = offsetAlong(run, origin);
  const across = -(origin.x - run.origin.x) * run.dir.y + (origin.y - run.origin.y) * run.dir.x;
  if (
    run.style !== style ||
    Math.abs(run.fontSize - size) > size * 1e-3 ||
    Math.abs(run.angle - glyph.angle) > ANGLE_EPSILON ||
    Math.abs(across) > BASELINE_EM * size
  ) {
    return null;
  }
  if (!run.rtl && offset >= run.width - MAX_OVERLAP_EM * size && offset <= run.width + MAX_GAP_EM * size) {
    return "forward";
  }
  // Right-to-left: the glyph's advance ends where the run starts.
  const endOffset = offsetAlong(run, end);
  const leftward =
    offset < 0 &&
    endOffset <= MAX_OVERLAP_EM * size &&
    endOffset >= -MAX_GAP_EM * size &&
    (run.rtl || (run.glyphs.length === 1 && RTL_LETTER.test(run.str) && RTL_LETTER.test(glyph.text)));
  return leftward ? "leftward" : null;
}

function sameBaseline(run: Run, other: Run): boolean {
  const across = -(other.origin.x - run.origin.x) * run.dir.y + (other.origin.y - run.origin.y) * run.dir.x;
  return Math.abs(run.angle - other.angle) <= ANGLE_EPSILON && Math.abs(across) <= BASELINE_EM * run.fontSize;
}

function offsetAlong(run: Run, point: PdfPoint): number {
  return (point.x - run.origin.x) * run.dir.x + (point.y - run.origin.y) * run.dir.y;
}

function along(run: Run, distance: number): PdfPoint {
  return { x: run.origin.x + run.dir.x * distance, y: run.origin.y + run.dir.y * distance };
}

function itemOf(run: Run, hasEOL: boolean): PdfTextItem {
  const { fontSize: size, dir, origin } = run;
  return {
    str: run.str,
    dir: run.rtl ? "rtl" : "ltr",
    transform: [size * dir.x, size * dir.y, -size * dir.y, size * dir.x, origin.x, origin.y],
    width: run.width,
    height: size,
    fontName: run.style,
    hasEOL,
  };
}

/** A space spanning the gap between a run and the next, as pdf.js emits:
 * from `from` to `to` along the run's baseline. */
function spaceItem(before: Run, from: PdfPoint, to: PdfPoint): PdfTextItem {
  const gap = (to.x - from.x) * before.dir.x + (to.y - from.y) * before.dir.y;
  return itemOf({ ...before, origin: from, str: " ", width: Math.max(0, gap), item: null, glyphs: [] }, false);
}

function cellOf(
  glyph: PdfiumGlyph,
  style: string,
  origin: PdfPoint,
  end: PdfPoint,
  dir: PdfPoint,
  size: number,
): PdfTextGlyph {
  const metrics = deterministicTextVerticalMetrics(size, {
    ascent: glyph.ascent / size,
    descent: glyph.descent / size,
  });
  const up = { x: -dir.y, y: dir.x };
  const shift = (p: PdfPoint, by: number) => ({ x: p.x + up.x * by, y: p.y + up.y * by });
  return {
    text: glyph.text,
    fontName: style,
    origin,
    end,
    quad: [
      shift(origin, metrics.ascent),
      shift(end, metrics.ascent),
      shift(end, -metrics.descent),
      shift(origin, -metrics.descent),
    ],
  };
}
