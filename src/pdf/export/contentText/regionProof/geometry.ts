import type { Rect, TextTrace } from './types';

export const EPS = 1e-7;
export const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance + EPS;
export const finiteMatrix = (m: readonly number[]) => m.length === 6 && m.every(Number.isFinite);
export const coefficientEqual = (a: number, b: number) =>
  Math.abs(a - b) <= Math.max(1e-9, 1e-6 * Math.max(Math.abs(a), Math.abs(b)));
export const matrixEqual = (a: readonly number[], b: readonly number[]) =>
  // Full snapshot translations come from the same numeric source walk;
  // relative coefficient tolerance must never license coordinate drift.
  a.length === b.length && a.every((v, i) => i < 4 ? coefficientEqual(v, b[i]!) : v === b[i]);

export function linear(t: TextTrace): readonly number[] {
  const [a, b, c, d] = t.tm, [e, f, g, h] = t.ctm;
  return [a! * e! + b! * g!, a! * f! + b! * h!, c! * e! + d! * g!, c! * f! + d! * h!];
}
export function origin(t: TextTrace): readonly [number, number] {
  const x = t.tm[4]! + t.rise * t.tm[2]!, y = t.tm[5]! + t.rise * t.tm[3]!;
  return [x * t.ctm[0]! + y * t.ctm[2]! + t.ctm[4]!,
    x * t.ctm[1]! + y * t.ctm[3]! + t.ctm[5]!];
}
export const physicalSize = (t: TextTrace) => t.size * Math.hypot(linear(t)[2]!, linear(t)[3]!);
export const physicalLeading = (t: TextTrace) => t.leading * linear(t)[3]!;
export function validTrace(t: TextTrace): boolean {
  if (![t.ctm, t.tm, t.tlm].every(finiteMatrix) ||
    ![t.bt, t.opIndex, t.size, t.tc, t.tw, t.tz, t.leading, t.rise, t.renderMode].every(Number.isFinite)) return false;
  const [a, b, c, d] = linear(t);
  return a! > 0 && d! > 0 && Math.abs(b!) <= 1e-9 && Math.abs(c!) <= 1e-9 &&
    t.size > 0 && t.tz > 0 && t.leading >= 0 && Number.isInteger(t.bt) &&
    Number.isInteger(t.opIndex) && t.renderMode === 0 &&
    !!t.fontObject && !!t.safetyHash;
}
export function compatible(t: TextTrace, base: TextTrace): boolean {
  return validTrace(t) && t.fontObject === base.fontObject &&
    t.safetyHash === base.safetyHash && near(physicalSize(t), physicalSize(base), 0.05) &&
    linear(t).every((n, i) => coefficientEqual(n, linear(base)[i]!)) &&
    (['tc', 'tw', 'tz', 'rise', 'renderMode'] as const).every(key => t[key] === base[key]);
}
export const validRect = (r: Rect) => [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w >= 0 && r.h >= 0;
export const contains = (outer: Rect, inner: Rect) => inner.x >= outer.x - EPS && inner.y >= outer.y - EPS &&
  inner.x + inner.w <= outer.x + outer.w + EPS && inner.y + inner.h <= outer.y + outer.h + EPS;
export const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w &&
  a.y < b.y + b.h && b.y < a.y + a.h;
