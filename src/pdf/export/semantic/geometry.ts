import type { PdfRect } from '../../model/types';
import { type3Bounds as bounds, type3Transform as transform } from '../fontCoverage/type3Paths';
import { composeFormMatrix, identity } from '../contentText/retypesetForms';
import type { ContentOp } from '../contentStreamEdit/tokenizer';

export { composeFormMatrix, identity, transform };

export function union(a: PdfRect | undefined, b: PdfRect | undefined): PdfRect | undefined {
  if (!a || !b) return a ?? b;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function box(points: ReadonlyArray<{ x: number; y: number }>): PdfRect | undefined {
  const b = bounds(points);
  return b && [b.x, b.y, b.w, b.h].every(Number.isFinite) ? b : undefined;
}

export function transformedBox(m: readonly number[], r: readonly number[]): PdfRect | undefined {
  const [x, y, right, top] = r as [number, number, number, number];
  return box(transform([{ x, y }, { x: right, y }, { x: right, y: top }, { x, y: top }], m));
}

const pathPoints = new Map([['m', 2], ['l', 2], ['c', 6], ['v', 4], ['y', 4], ['re', 4]]);
const fills = new Set(['f', 'F', 'f*', 'B', 'B*', 'b', 'b*']);
const strokes = new Set(['S', 's', 'B', 'B*', 'b', 'b*']);

function operands(op: ContentOp, length: number): number[] | undefined {
  if (op.operands.length !== length) return undefined;
  const values = op.operands.map(item => item.kind === 'number' ? item.value : NaN);
  return values.every(Number.isFinite) ? values : undefined;
}

// Follow paths and Do independently of the text walk so a broken font
// cannot hide a subsequent Form or unmark its operators.
export function tracePaint(
  ops: ContentOp[],
  initial: readonly number[] | undefined,
  onPaint: (index: number, matrix?: readonly number[], bounds?: PdfRect) => void,
): void {
  const stack: (readonly number[] | undefined)[] = [];
  let matrix: readonly number[] | undefined = initial;
  let path: PdfRect | undefined;
  let invalidPath = false;
  for (const [index, op] of ops.entries()) {
    const { operator } = op;
    if (operator === 'q') {
      stack.push(matrix);
    } else if (operator === 'Q') {
      matrix = stack.pop();
    } else if (operator === 'cm') {
      const local = operands(op, 6);
      matrix = matrix && local ? composeFormMatrix(matrix, local) : undefined;
    } else if (operator === 'Do' || operator === 'BI' || operator === 'sh') {
      onPaint(index, matrix, operator === 'BI' && matrix ? transformedBox(matrix, [0, 0, 1, 1]) : undefined);
    } else if (pathPoints.has(operator)) {
      const coords = operands(op, pathPoints.get(operator)!);
      if (!coords || !matrix) {
        invalidPath = true;
      } else if (operator === 're') {
        path = union(path, transformedBox(matrix, [coords[0]!, coords[1]!, coords[0]! + coords[2]!, coords[1]! + coords[3]!]));
      } else {
        const points = [];
        for (let i = 0; i < coords.length; i += 2) points.push({ x: coords[i]!, y: coords[i + 1]! });
        path = union(path, box(transform(points, matrix)));
      }
    } else if (fills.has(operator) || strokes.has(operator) || operator === 'n') {
      // A fill's control-point hull encloses its path. Stroke bounds also
      // depend on the graphics state and are left unknown.
      if (operator !== 'n') onPaint(index, matrix, invalidPath || strokes.has(operator) ? undefined : path);
      path = undefined;
      invalidPath = false;
    }
  }
}
