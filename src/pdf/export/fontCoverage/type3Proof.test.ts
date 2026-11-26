import { expect, test } from 'bun:test';
import { PDFDocument } from 'pdf-lib';
import { fontInputFromDict } from './pdfLibAdapter';
import { proveType3Glyph, checkType3Target, type Type3FontInput, type Type3PaintState } from './type3Proof';
import { contentFontInfo } from '../contentStreamEdit/glyphWidths';

// Failure inventory (F8 only): undefined/unencoded proc; invalid FontMatrix;
// d1/Widths mismatch, wy, omitted or duplicate d1; malformed operands; every
// allowed path idiom including implicit v/y controls and negative re corners;
// declared bbox lies; path/q leak; cm, d0, resources, text, clip, stroke, color;
// empty non-whitespace; stale proc/encoding/metrics; target color/clip/transform
// dependencies, clipping at the new position; walker must remain disabled.
const bytes = (s: string) => new TextEncoder().encode(s);
const safe = '600 0 0 0 600 700 d1 0 0 m 600 0 l 0 700 l h f';
const input = (proc = safe, extra: Partial<Type3FontInput> = {}): Type3FontInput => ({
  subtype: 'Type3', firstChar: 65, lastChar: 65, widths: [600], fontMatrix: [.001, 0, 0, .001, 0, 0],
  encoding: { differences: { 65: 'A' } }, toUnicode: '1 beginbfchar <41> <0041> endbfchar',
  charProcs: ['A'], type3CharProcs: { A: bytes(proc) }, ...extra,
});
const paint = (extra: Partial<Type3PaintState> = {}): Type3PaintState => ({
  transform: [10, 0, 0, 10, 50, 100], clip: { x: 0, y: 0, w: 300, h: 200 },
  fillColor: { space: 'DeviceRGB', values: [0, 0, 0] }, renderMode: 0, fillAlpha: 1, blendMode: 'Normal', softMask: 'None', ...extra,
});
test('d1 metrics normalize FontMatrix scale and include translation only in ink', () => {
  const p = proveType3Glyph(input(safe, { fontMatrix: [.002, 0, 0, .003, .1, -.2] }), 65);
  expect(p.ok).toBe(true); if (!p.ok) return;
  expect(p.proof.width1000).toBe(1200);
  expect(p.proof.rawBounds).toEqual({ x: 0, y: 0, w: 600, h: 700 });
  expect(p.proof.inkBounds.x).toBeCloseTo(.1); expect(p.proof.inkBounds.y).toBeCloseTo(-.2);
  expect(p.proof.inkBounds.w).toBeCloseTo(1.2); expect(p.proof.inkBounds.h).toBeCloseTo(2.1);
  expect(p.proof.readSet).toContain('fillColor'); expect(p.proof.readSet).toContain('callerTransform');
});
for (const path of [
  'q 0 0 600 700 re f Q', '600 700 -600 -700 re f*',
  '0 0 m 0 700 600 700 600 0 c h f', '0 0 m 600 700 600 0 v h f',
  '0 0 m 0 700 600 0 y h f', '0 0 m 600 0 l 600 700 l h n 0 0 500 500 re f',
]) test(`safe fill path: ${path}`, () => {
  expect(proveType3Glyph(input(`600 0 0 0 600 700 d1 ${path}`), 65).ok).toBe(true);
});
for (const [extra, code] of [
  [{ encoding: { differences: { 65: 'Missing' } } }, 'type3-charproc-missing'],
  [{ encoding: undefined }, 'type3-charproc-missing'],
  [{ type3CharProcs: {} }, 'type3-charproc-missing'],
  [{ widths: undefined }, 'type3-width-invalid'], [{ widths: [601] }, 'type3-width-invalid'],
  [{ firstChar: 66 }, 'type3-width-invalid'], [{ lastChar: 64 }, 'type3-width-invalid'],
  [{ widths: [NaN] }, 'type3-width-invalid'],
] as const) test(`font proof refuses ${JSON.stringify(extra)}`, () => {
  expect(proveType3Glyph(input(safe, extra), 65)).toMatchObject({ ok: false, code });
});
for (const fontMatrix of [undefined, [0, 0, 0, .001, 0, 0], [-.001, 0, 0, .001, 0, 0], [.001, .001, 0, .001, 0, 0], [.001, 0, .001, .001, 0, 0], [.001, 0, 0, .001, Infinity, 0], [.001]]) {
  test(`unsupported FontMatrix ${fontMatrix}`, () => expect(proveType3Glyph(input(safe, { fontMatrix }), 65)).toMatchObject({ ok: false, code: 'type3-matrix-unsupported' }));
}
for (const [proc, code] of [
  ['600 1 0 0 600 700 d1 0 0 100 100 re f', 'type3-width-invalid'],
  ['0 0 600 700 re f', 'type3-charproc-unsafe'],
  ['600 0 0 0 600 700 d1 600 0 0 0 600 700 d1', 'type3-charproc-unsafe'],
  ['600 0 0 0 20 20 d1 -1 0 10 10 re f', 'type3-charproc-unsafe'],
  ['600 0 0 0 20 20 d1 5 5 -10 10 re f', 'type3-charproc-unsafe'],
  ['600 0 0 0 20 20 d1 30 0 m 5 5 10 0 v f', 'type3-charproc-unsafe'],
  ['600 0 0 0 20 20 d1 0 0 m 40 10 10 0 y f', 'type3-charproc-unsafe'],
  ['600 0 0 0 20 20 d1 0 0 m 0 10 40 10 10 0 c f', 'type3-charproc-unsafe'],
  ['600 0 0 0 600 700 d1 0 0 m', 'type3-charproc-unsafe'],
  ['600 0 0 0 600 700 d1 q 0 0 100 100 re f', 'type3-charproc-unsafe'],
  ['600 0 0 0 600 700 d1 Q', 'type3-charproc-unsafe'],
  ['600 0 0 0 600 700 d1 10 l', 'content-malformed'],
  ['600 0 0 0 600 700 d1 (oops', 'content-malformed'],
] as const) test(`proc refusal: ${proc}`, () => expect(proveType3Glyph(input(proc), 65)).toMatchObject({ ok: false, code }));
for (const [operator, body] of [
  ['cm', '2 0 0 2 0 0 cm'], ['d0', '600 0 d0'], ['Do', '/X Do'], ['BT', 'BT'],
  ['BI', 'BI /W 1 /H 1 /L 1 ID x EI'], ['sh', '/S sh'], ['W', 'W'], ['W*', 'W*'],
  ['gs', '/G gs'], ['S', '0 0 m 10 10 l S'], ['rg', '1 0 0 rg'], ['BMC', '/P BMC'],
  ['BX', 'BX'], ['scn', '/Pattern scn'],
] as const) test(`unsupported operator ${operator} carries precise evidence`, () => {
  const proc = operator === 'd0' ? body : `600 0 0 0 600 700 d1 ${body}`;
  expect(proveType3Glyph(input(proc), 65)).toMatchObject({ ok: false, code: 'type3-charproc-unsafe', data: { operator } });
});
test('empty procedures require already mapped whitespace/formatting and proven advance', () => {
  expect(proveType3Glyph(input('600 0 0 0 0 0 d1'), 65)).toMatchObject({ ok: false, code: 'type3-charproc-unsafe' });
  expect(proveType3Glyph(input('600 0 0 0 0 0 d1', { toUnicode: '1 beginbfchar <41> <0020> endbfchar' }), 65).ok).toBe(true);
});
test('target proof enforces inherited paint state, unchanged clip and new-position containment', () => {
  const p = proveType3Glyph(input(), 65); expect(p.ok).toBe(true); if (!p.ok) return;
  expect(checkType3Target(p.proof, paint(), paint({ transform: [10, 0, 0, 10, 70, 100] })).ok).toBe(true);
  for (const target of [
    paint({ fillColor: { space: 'DeviceRGB', values: [1, 0, 0] } }), paint({ fillAlpha: .5 }),
    paint({ blendMode: 'Multiply' }), paint({ softMask: 'mask' }), paint({ renderMode: 2 }),
    paint({ clip: { x: 0, y: 0, w: 60, h: 200 } }), paint({ transform: [20, 0, 0, 10, 50, 100] }),
    paint({ transform: [10, 0, 0, 10, 299, 100] }),
  ]) expect(checkType3Target(p.proof, paint(), target).ok).toBe(false);
});
test('cm scale that crosses a clip is always refused before target eligibility', () => {
  expect(proveType3Glyph(input('600 0 0 0 20 20 d1 2 0 0 2 0 0 cm 0 0 8 8 re f'), 65))
    .toMatchObject({ ok: false, code: 'type3-charproc-unsafe', data: { operator: 'cm' } });
});
test('proof hash changes with proc, encoding, and metrics dependencies', () => {
  const proofs = [input(), input(safe.replace('600 0 l', '500 0 l')),
    input(safe, { encoding: { differences: { 65: 'A', 66: 'A' } } }), input(safe, { fontMatrix: [.002, 0, 0, .001, 0, 0] })]
    .map(f => proveType3Glyph(f, 65));
  expect(proofs.every(p => p.ok)).toBe(true);
  expect(new Set(proofs.flatMap(p => p.ok ? [p.proof.dependencyHash] : [])).size).toBe(4);
});
test('adapter supplies decoded proc bytes, but F8 does not enable Type3 walking', async () => {
  const doc = await PDFDocument.create(), ctx = doc.context;
  const font = ctx.obj({ Type: 'Font', Subtype: 'Type3', FontMatrix: [.001, 0, 0, .001, 0, 0], FontBBox: [0, 0, 600, 700],
    FirstChar: 65, LastChar: 65, Widths: [600], Encoding: { Differences: [65, 'A'] }, CharProcs: { A: ctx.register(ctx.flateStream(safe)) } });
  expect(proveType3Glyph(fontInputFromDict(font), 65).ok).toBe(true);
  expect(contentFontInfo(font)).toMatchObject({ ok: false, reason: 'Type3 font' });
});
