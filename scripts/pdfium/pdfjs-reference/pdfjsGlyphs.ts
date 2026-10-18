// pdf.js's positioned glyphs, read from the page's operator list: the glyph
// geometry the app's reading layer took from pdf.js before PDFium replaced it.
// Kept as a reference for validating PDFium's (scripts/pdfium/*) and as an
// input builder for selection tests; not part of the app.
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PdfPoint } from "../../../src/pdf/model/types";
import type { PdfTextGlyph } from "../../../src/pdf/engine/text";
import { deterministicTextVerticalMetrics } from "../../../src/pdf/geometry/textMetrics";

type Matrix = readonly number[];
const IDENTITY = [1, 0, 0, 1, 0, 0];

export type GlyphFont = {
  fontMatrix?: number[];
  ascent?: number;
  descent?: number;
  vertical?: boolean;
  defaultVMetrics?: number[];
};
type OperatorGlyph = {
  unicode: string;
  width: number;
  isSpace?: boolean;
  vmetric?: number[];
};

type TextState = {
  ctm: Matrix;
  tm: Matrix;
  x: number;
  y: number;
  lineX: number;
  lineY: number;
  size: number;
  direction: number;
  fontName: string;
  font: GlyphFont | null;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  leading: number;
  rise: number;
};

function multiply(m: Matrix, n: Matrix): number[] {
  return [
    m[0]! * n[0]! + m[2]! * n[1]!, m[1]! * n[0]! + m[3]! * n[1]!,
    m[0]! * n[2]! + m[2]! * n[3]!, m[1]! * n[2]! + m[3]! * n[3]!,
    m[0]! * n[4]! + m[2]! * n[5]! + m[4]!,
    m[1]! * n[4]! + m[3]! * n[5]! + m[5]!,
  ];
}

function point(m: Matrix, x: number, y: number): PdfPoint {
  return { x: m[0]! * x + m[2]! * y + m[4]!, y: m[1]! * x + m[3]! * y + m[5]! };
}

/** Read the same positioned glyphs that PDF.js paints, not stretched DOM text.
 * Operator lists are already requested by the text layer for font resolution.
 * Keep this independent of zoom, DOM fonts, locale, and the page's CropBox.
 */
export function textGlyphsFromOperators(
  operators: { fnArray: number[]; argsArray: unknown[] },
  resolveFont: (id: string) => GlyphFont | null,
): PdfTextGlyph[] {
  let state: TextState = {
    ctm: IDENTITY, tm: IDENTITY, x: 0, y: 0, lineX: 0, lineY: 0,
    size: 0, direction: 1, fontName: "", font: null,
    charSpacing: 0, wordSpacing: 0, hScale: 1, leading: 0, rise: 0,
  };
  const stack: TextState[] = [];
  const out: PdfTextGlyph[] = [];
  let annotation = false;
  const setFont = (id: string, size: number) => {
    state.fontName = id;
    state.size = Math.abs(size);
    state.direction = size < 0 ? -1 : 1;
    try { state.font = resolveFont(id); } catch { state.font = null; }
  };
  const move = (x: number, y: number) => {
    state.x = state.lineX += x;
    state.y = state.lineY += y;
  };

  for (let i = 0; i < operators.fnArray.length; i += 1) {
    const op = operators.fnArray[i];
    // Annotation appearances are not document text and may reuse its fonts.
    if (op === OPS.beginAnnotation) { annotation = true; continue; }
    if (op === OPS.endAnnotation) { annotation = false; continue; }
    if (annotation) continue;
    const args = (operators.argsArray[i] ?? []) as unknown[];
    switch (op) {
      case OPS.save: stack.push({ ...state }); break;
      case OPS.restore: state = stack.pop() ?? state; break;
      case OPS.transform: state.ctm = multiply(state.ctm, args as number[]); break;
      case OPS.paintFormXObjectBegin:
        stack.push({ ...state });
        if (args[0]) state.ctm = multiply(state.ctm, args[0] as Matrix);
        break;
      case OPS.paintFormXObjectEnd: state = stack.pop() ?? state; break;
      case OPS.beginText:
        state.tm = IDENTITY;
        state.x = state.y = state.lineX = state.lineY = 0;
        break;
      case OPS.setTextMatrix:
        state.tm = args[0] as Matrix;
        state.x = state.y = state.lineX = state.lineY = 0;
        break;
      case OPS.setFont: setFont(args[0] as string, args[1] as number); break;
      case OPS.setGState:
        for (const [key, value] of args[0] as Array<[string, unknown]>) {
          if (key === "Font") {
            const [id, size] = value as [string, number];
            setFont(id, size);
          }
        }
        break;
      case OPS.setCharSpacing: state.charSpacing = args[0] as number; break;
      case OPS.setWordSpacing: state.wordSpacing = args[0] as number; break;
      case OPS.setHScale: state.hScale = (args[0] as number) / 100; break;
      case OPS.setLeading: state.leading = -(args[0] as number); break;
      case OPS.setTextRise: state.rise = args[0] as number; break;
      case OPS.moveText: move(args[0] as number, args[1] as number); break;
      case OPS.setLeadingMoveText:
        state.leading = args[1] as number;
        move(args[0] as number, args[1] as number);
        break;
      case OPS.nextLine: move(0, state.leading); break;
      case OPS.showText: {
        if (!state.font || !Number.isFinite(state.size) || state.size === 0) break;
        const font = state.font;
        const advanceScale = state.size * (font.fontMatrix?.[0] ?? 0.001);
        const horizontalScale = state.hScale * state.direction;
        const transform = multiply(state.ctm, state.tm);
        const metrics = deterministicTextVerticalMetrics(state.size, {
          ascent: font.ascent ?? 0.8, descent: font.descent ?? -0.2,
        });
        let advance = 0;
        for (const glyph of args[0] as Array<OperatorGlyph | number>) {
          if (typeof glyph === "number") {
            advance += (font.vertical ? 1 : -1) * glyph * state.size / 1000;
            continue;
          }
          if (!Number.isFinite(glyph.width)) continue;
          const spacing = state.charSpacing + (glyph.isSpace ? state.wordSpacing : 0);
          let x = advance, y = 0, width = glyph.width * advanceScale;
          let quad: Array<[number, number]>;
          let endX: number, endY: number;
          if (font.vertical) {
            const vm = glyph.vmetric ?? font.defaultVMetrics;
            if (!vm) continue;
            x = -(glyph.vmetric ? vm[1]! : glyph.width * 0.5) * advanceScale;
            y = -advance - vm[2]! * advanceScale;
            width = -vm[0]! * advanceScale;
            // The vertical advance runs down the page. Its cross-axis width
            // remains the glyph's horizontal em advance.
            const right = x + glyph.width * advanceScale;
            quad = [[x, y + metrics.ascent], [right, y + metrics.ascent],
              [right, y - metrics.descent], [x, y - metrics.descent]];
            endX = x; endY = y - width;
            advance += width - spacing * state.direction;
          } else {
            quad = [[x, metrics.ascent], [x + width, metrics.ascent],
              [x + width, -metrics.descent], [x, -metrics.descent]];
            endX = x + width; endY = y;
            advance += width + spacing * state.direction;
          }
          const place = (px: number, py: number) => point(
            transform,
            state.x + px * horizontalScale,
            state.y + state.rise + py * state.direction,
          );
          const corners = quad.map(([qx, qy]) => place(qx, qy));
          if (corners.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))) {
            out.push({ text: glyph.unicode, fontName: state.fontName,
              origin: place(x, y), end: place(endX, endY), quad: corners });
          }
        }
        if (font.vertical) state.y -= advance;
        else state.x += advance * horizontalScale;
        break;
      }
    }
  }
  return out;
}
