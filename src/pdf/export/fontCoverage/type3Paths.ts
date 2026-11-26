import { ContentStreamParseError, tokenizeContentStream, type ContentOp } from '../contentStreamEdit/tokenizer';

export type Type3Reason = 'type3-charproc-missing' | 'type3-charproc-unsafe' | 'type3-matrix-unsupported' | 'type3-width-invalid' | 'content-malformed';
export type Type3Failure = { ok: false; code: Type3Reason; reason: string; data?: { operator: string } };
export type Type3Point = { x: number; y: number };
export type Type3Box = { x: number; y: number; w: number; h: number };
export const type3Failure = (code: Type3Reason, reason: string, operator?: string): Type3Failure =>
  ({ ok: false, code, reason, ...(operator ? { data: { operator } } : {}) });

export function type3Bounds(points: readonly Type3Point[]): Type3Box | null {
  if (!points.length) return null;
  let left = Infinity, bottom = Infinity, right = -Infinity, top = -Infinity;
  for (const p of points) { left = Math.min(left, p.x); bottom = Math.min(bottom, p.y); right = Math.max(right, p.x); top = Math.max(top, p.y); }
  return { x: left, y: bottom, w: right - left, h: top - bottom };
}
export function type3Transform(points: readonly Type3Point[], m: readonly number[]): Type3Point[] {
  return points.map(p => ({ x: m[0]! * p.x + m[2]! * p.y + m[4]!, y: m[1]! * p.x + m[3]! * p.y + m[5]! }));
}
function convexHull(points: Type3Point[]): Type3Point[] {
  const sorted = [...new Map(points.map(p => [`${p.x},${p.y}`, p])).values()].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (a: Type3Point, b: Type3Point, c: Type3Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const half = (list: Type3Point[]) => {
    const out: Type3Point[] = [];
    for (const p of list) { while (out.length > 1 && cross(out.at(-2)!, out.at(-1)!, p) <= 0) out.pop(); out.push(p); }
    return out;
  };
  if (sorted.length < 3) return sorted;
  return [...half(sorted).slice(0, -1), ...half([...sorted].reverse()).slice(0, -1)];
}
export const type3Numbers = (op: ContentOp, count: number): number[] | null =>
  op.operands.length === count && op.operands.every(o => o.kind === 'number' && Number.isFinite(o.value))
    ? op.operands.map(o => (o as { value: number }).value) : null;

const unsafe = (reason: string, operator?: string) => type3Failure('type3-charproc-unsafe', reason, operator);

export function readType3CharProc(bytes: Uint8Array): ContentOp[] | Type3Failure {
  if (bytes.length > 1024 * 1024) return unsafe('CharProc byte budget exceeded');
  let ops: ContentOp[];
  try { ops = tokenizeContentStream(bytes); }
  catch (error) {
    if (!(error instanceof ContentStreamParseError)) throw error;
    return type3Failure('content-malformed', error.message);
  }
  if (ops.length > 100000) return unsafe('CharProc operator budget exceeded');
  return ops;
}

type Type3Graphics = {
  save: () => void;
  restore: () => void;
  concat: (matrix: number[]) => void;
  clip: (points: readonly Type3Point[]) => void;
};
const pathArities: Readonly<Record<string, number>> = { m: 2, l: 2, c: 6, v: 4, y: 4, h: 0, re: 4, f: 0, 'f*': 0, n: 0, q: 0, Q: 0 };
const paintArities: Readonly<Record<string, number>> = { cm: 6, W: 0, 'W*': 0, F: 0, g: 1, rg: 3, k: 4 };

/** Visit the control points of each fill. Optional graphics handling is for
 * read-only bounds of foreign paint. Glyph reuse keeps the strict subset. */
export function traceType3Fills(
  ops: readonly ContentOp[], fill: (points: readonly Type3Point[]) => void, graphics?: Type3Graphics,
): Type3Failure | null {
  let current: Type3Point | null = null, start: Type3Point | null = null, depth = 0;
  let path: Type3Point[] = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    const count = pathArities[op.operator] ?? (graphics ? paintArities[op.operator] : undefined);
    if (count === undefined) return unsafe('Unsupported CharProc painting operator', op.operator);
    const n = type3Numbers(op, count);
    if (!n) return type3Failure('content-malformed', `Malformed ${op.operator} operands`, op.operator);
    if (graphics && n.some(v => !Number.isFinite(Math.fround(v)))) return unsafe('CharProc coordinate exceeds renderer range', op.operator);
    const point = (i: number): Type3Point => ({ x: n[i]!, y: n[i + 1]! });
    if (op.operator === 'q' || op.operator === 'Q') {
      if (path.length) return unsafe('Path crosses a graphics-state boundary', op.operator);
      depth += op.operator === 'q' ? 1 : -1;
      if (depth < 0 || depth > 64) return unsafe('Unbalanced or excessive q/Q', op.operator);
      if (op.operator === 'q') graphics?.save();
      else graphics?.restore();
    } else if (op.operator === 'cm') {
      if (path.length) return unsafe('Transform changes within a path', op.operator);
      graphics!.concat(n);
    } else if (op.operator === 'W' || op.operator === 'W*') {
      // A single rectangle followed by n installs a known clip.
      const end = ops[i + 1];
      if (ops[i - 1]?.operator !== 're' || path.length !== 4 || end?.operator !== 'n' || end.operands.length) {
        return unsafe('Unsupported clip path', op.operator);
      }
      graphics!.clip(path);
      path = []; current = start = null;
      i++;
    } else if (op.operator === 'g' || op.operator === 'rg' || op.operator === 'k') {
      if (path.length) return unsafe('Color changes within a path', op.operator);
    } else if (op.operator === 'm') {
      current = start = point(0); path.push(current);
    } else if (op.operator === 're') {
      const p = point(0), w = n[2]!, h = n[3]!;
      path.push(p, { x: p.x + w, y: p.y }, { x: p.x + w, y: p.y + h }, { x: p.x, y: p.y + h }); current = start = p;
    } else if (op.operator === 'f' || op.operator === 'F' || op.operator === 'f*' || op.operator === 'n') {
      if (op.operator !== 'n' && path.length) fill(path);
      path = []; current = start = null;
    } else {
      if (!current || !start) return unsafe('Path operator has no current point', op.operator);
      // Include the implicit first control for v, and implicit second control
      // for y; all controls/endpoints conservatively contain the cubic ink.
      path.push(current);
      if (op.operator === 'h') { path.push(start); current = start; }
      else {
        for (let i = 0; i < n.length; i += 2) path.push(point(i));
        current = point(n.length - 2);
      }
    }
  }
  if (depth || path.length) return unsafe('CharProc leaks path or graphics state');
  return null;
}

/** F8 structural proof only. No resources, colors, text, clipping, cm or d0. */
export function type3PathProof(bytes: Uint8Array):
  { ok: true; wx: number; wy: number; declaredBounds: Type3Box; hull: Type3Point[] } | Type3Failure {
  const ops = readType3CharProc(bytes);
  if (!Array.isArray(ops)) return ops;
  const first = ops[0];
  if (!first || first.operator !== 'd1') return unsafe('CharProc requires a single leading d1', first?.operator);
  const metrics = type3Numbers(first, 6);
  if (!metrics) return type3Failure('content-malformed', 'Malformed d1 operands', 'd1');
  const [wx, wy, left, bottom, right, top] = metrics as [number, number, number, number, number, number];
  if (right < left || top < bottom) return unsafe('Invalid d1 bounds', 'd1');
  const painted: Type3Point[] = [];
  const failure = traceType3Fills(ops.slice(1), points => { for (const p of points) painted.push(p); });
  if (failure) return failure;
  if (painted.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < left || p.x > right || p.y < bottom || p.y > top)) return unsafe('Path hull is outside d1 bounds');
  const hull = convexHull(painted);
  return { ok: true, wx, wy, declaredBounds: { x: left, y: bottom, w: right - left, h: top - bottom }, hull: hull.length >= 3 ? hull : [] };
}
