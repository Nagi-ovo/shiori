import { PDFDict, PDFName, PDFNumber, PDFStream } from 'pdf-lib';
import type { PdfRect } from '../../../model/types';
import type { ContentFontInfo } from '../../contentStreamEdit/glyphWidths';
import type { Point, ShowTextState } from '../../contentStreamEdit/textStateTypes';
import { simpleNames } from '../../fontCoverage/encodings';
import { readFontEncoding, streamBytes } from '../../fontCoverage/pdfLibAdapter';
import { readType3CharProc, traceType3Fills, type3Bounds, type3Numbers, type3Transform } from '../../fontCoverage/type3Paths';
import { numericArray } from '../reflowScene';
import { composeFormMatrix, formPageBox, identity } from '../retypesetForms';

type Type3Metrics = {
  metrics: ContentFontInfo;
  matrix: readonly number[];
  box: (code: number) => PdfRect | null | undefined;
};

const finiteCoordinate = (value: number) => Number.isFinite(Math.fround(value));
const finiteBox = (r: PdfRect) => [r.x, r.y, r.x + r.w, r.y + r.h, r.w, r.h].every(finiteCoordinate);
const finiteMatrix = (m: readonly number[] | undefined): m is readonly number[] =>
  m?.length === 6 && m.every(finiteCoordinate);

function intersect(a: PdfRect, b: PdfRect): PdfRect | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x, h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w < 0 || h < 0 ? null : { x, y, w, h };
}

/** undefined means the paint is unproved. null means the procedure paints
 * nothing within its clip. PDFium can paint outside both FontBBox and
 * d1. Only the procedure's clipping operators constrain the traced ink. */
function charProcBounds(proc: PDFStream): PdfRect | null | undefined {
  // The stream decoder does not apply predictors.
  if (proc.dict.has(PDFName.of('DecodeParms'))) return;
  const matrix = proc.dict.has(PDFName.of('Matrix')) ? numericArray(proc.dict, 'Matrix') : identity;
  if (!finiteMatrix(matrix)) return;
  const ops = readType3CharProc(streamBytes(proc));
  if (!Array.isArray(ops)) return;
  const first = ops[0];
  const hasMetrics = first?.operator === 'd0' || first?.operator === 'd1';
  if (hasMetrics) {
    const n = type3Numbers(first, first.operator === 'd0' ? 2 : 6);
    if (!n || !n.every(finiteCoordinate) || n[1] !== 0 || (n.length === 6 && (n[2]! > n[4]! || n[3]! > n[5]!))) return;
  }
  type State = { matrix: readonly number[]; clip?: PdfRect | null };
  let state: State = { matrix };
  const stack: State[] = [];
  let ink: PdfRect | null = null;
  const pathBox = (points: readonly Point[]) => {
    const b = type3Bounds(type3Transform(points, state.matrix))!;
    if (!finiteBox(b)) throw new Error('nonfinite Type3 path');
    return b;
  };
  const failure = traceType3Fills(hasMetrics ? ops.slice(1) : ops, points => {
    const b = pathBox(points);
    const visible = state.clip === undefined ? b : state.clip && intersect(b, state.clip);
    if (!visible) return;
    if (!ink) {
      ink = visible;
    } else {
      const x = Math.min(ink.x, visible.x), y = Math.min(ink.y, visible.y);
      ink = { x, y, w: Math.max(ink.x + ink.w, visible.x + visible.w) - x, h: Math.max(ink.y + ink.h, visible.y + visible.h) - y };
    }
  }, {
    save: () => stack.push(state),
    restore: () => { state = stack.pop()!; },
    concat: local => {
      const matrix = composeFormMatrix(state.matrix, local);
      if (!finiteMatrix(matrix)) throw new Error('nonfinite Type3 transform');
      state = { ...state, matrix };
    },
    clip: points => {
      const b = pathBox(points), m = state.matrix;
      const determinant = m[0]! * m[3]! - m[1]! * m[2]!;
      if (!determinant || points[0]!.x === points[2]!.x || points[0]!.y === points[2]!.y) throw new Error('degenerate Type3 clip');
      state = { ...state, clip: state.clip === undefined ? b : state.clip && intersect(b, state.clip) };
    },
  });
  if (failure || (ink && !finiteBox(ink))) return;
  return ink;
}

export function type3Metrics(raw: PDFDict): Type3Metrics | undefined {
  const encoding = readFontEncoding(raw);
  if (!encoding || (typeof encoding !== 'string' && encoding.cmap !== undefined)) return;
  const base = typeof encoding === 'string' ? encoding : encoding.base;
  if (base !== undefined && !['StandardEncoding', 'WinAnsiEncoding', 'MacRomanEncoding'].includes(base)) return;
  const names = simpleNames({ subtype: 'Type3', encoding });
  const matrix = numericArray(raw, 'FontMatrix');
  if (!finiteMatrix(matrix)) return;
  const first = raw.lookupMaybe(PDFName.of('FirstChar'), PDFNumber)?.asNumber() ?? NaN;
  const last = raw.lookupMaybe(PDFName.of('LastChar'), PDFNumber)?.asNumber() ?? NaN;
  const widths = numericArray(raw, 'Widths');
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last > 255 || last < first || !widths) return;
  const procs = raw.lookupMaybe(PDFName.of('CharProcs'), PDFDict);
  if (!procs) return;
  const boxes = new Map<number, PdfRect | null | undefined>();
  const box = (code: number) => {
    if (!boxes.has(code)) {
      const name = names.get(code);
      const proc = name && name !== '.notdef' ? procs.lookupMaybe(PDFName.of(name), PDFStream) : undefined;
      boxes.set(code, proc && charProcBounds(proc));
    }
    return boxes.get(code);
  };
  const widthOf = (code: number) => {
    if (code < first || code > last) return NaN;
    // PDFium normalizes Widths to whole thousandths of text space.
    // A zero normalized width can fall back to CharProc metrics.
    const units = Math.fround(Math.fround(Math.fround(widths[code - first]!) * Math.fround(matrix[0]!)) * 1000);
    const width = Math.sign(units) * Math.round(Math.abs(units));
    return width && Math.abs(width) <= 0x7fffffff ? width : NaN;
  };
  const metrics: ContentFontInfo = { ok: true, bytesPerCode: 1, appliesWordSpacing: true, ascentEm: 1, descentEm: 0, widthOf };
  return { metrics, box, matrix };
}

export function type3Ink(font: Type3Metrics, code: number, s: ShowTextState, origin: Point): PdfRect | null | undefined {
  const b = font.box(code);
  if (!b) return b;
  const tm = s.textMatrix!, ctm = s.ctm!;
  const scaled = composeFormMatrix([s.fontSize * s.horizontalScale!, 0, 0, s.fontSize, 0, 0], font.matrix);
  const linear = composeFormMatrix([ctm[0]!, ctm[1]!, ctm[2]!, ctm[3]!, origin.x, origin.y], [tm[0]!, tm[1]!, tm[2]!, tm[3]!, 0, 0]);
  const r = formPageBox(composeFormMatrix(linear, scaled), b);
  const guarded = { x: r.x - .01, y: r.y - .01, w: r.w + .02, h: r.h + .02 };
  return finiteBox(guarded) ? guarded : undefined;
}
