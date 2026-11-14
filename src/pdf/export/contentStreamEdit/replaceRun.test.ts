import { describe, expect, test } from 'bun:test';
import { replaceRuns, sourceFingerprint, type ResolvedRunFont, type RunEdit } from './replaceRun';
import { tokenizeContentStream } from './tokenizer';
import { walkTextPlacements } from './textState';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const font: ResolvedRunFont = {
  resourceName: 'F1', objectId: '7 0 R', bytesPerCode: 1,
  widthOf: c => c === 32 ? 250 : 500, ascentEm: .8, descentEm: -.2,
  unicodeByCode: new Map(Array.from({ length: 95 }, (_, i) => [i + 32, String.fromCharCode(i + 32)])),
};
function edit(source: Uint8Array, old: string, replacement: string, occurrence = 0): RunEdit {
  const ops = tokenizeContentStream(source);
  const matches = ops.flatMap((op, opIndex) => {
    const items = op.operator === 'TJ' && op.operands[0]?.kind === 'array'
      ? op.operands[0].items : op.operands;
    return items.flatMap((item, index) => item.kind === 'string' && text(item.bytes) === old
      ? [{ opIndex, itemIndex: op.operator === 'TJ' ? index : -1, expected: item.bytes }] : []);
  });
  return { ...matches[occurrence]!, fontResource: 'F1', fontObject: '7 0 R',
    byteStart: 0, byteEnd: bytes(old).length, replacement };
}
function compile(source: Uint8Array, edits: RunEdit[], extra = {}) {
  return replaceRuns(source, [font], { sourceHash: sourceFingerprint(source), edits, ...extra });
}
function positions(source: Uint8Array, f = font) {
  const result = walkTextPlacements(tokenizeContentStream(source), {
    resolveFont: () => ({ ...f, ok: true, appliesWordSpacing: f.bytesPerCode === 1 }),
  });
  if (!result.ok) throw Error(result.reason);
  return result.glyphs.map(g => ({ code: g.code, x: g.coreQuad[0].x, y: g.coreQuad[0].y }));
}
function refused(source: Uint8Array, result: ReturnType<typeof compile>) {
  expect(result.ok).toBe(false);
  expect(result.bytes).toBe(source);
  if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
}

describe('fixed-neighbour same-font compiler', () => {
  const source = bytes('% untouched\nBT /F1 10 Tf 50 200 Td [(Hello) 120 ( suffix)] TJ (tail) Tj 0 -20 Td (next) Tj ET\n% end');
  test('identity preserves exact bytes; forced round trip rewrites while preserving all origins and kerns', () => {
    const e = edit(source, 'Hello', 'Hello');
    expect(compile(source, [e]).bytes).toBe(source);
    const forced = compile(source, [e], { forceReencode: true });
    expect(forced.ok).toBe(true);
    expect(text(forced.bytes)).not.toBe(text(source));
    expect(positions(forced.bytes)).toEqual(positions(source));
    expect(text(forced.bytes)).toContain('120');
  });
  for (const replacement of ['', 'Hi', 'Hello World']) {
    test(`replacement ${JSON.stringify(replacement)} preserves same-TJ suffix, relative Tj and Td`, () => {
      const result = compile(source, [edit(source, 'Hello', replacement)]);
      expect(result.ok).toBe(true);
      expect(positions(result.bytes).slice(replacement.length)).toEqual(positions(source).slice(5));
      expect(text(result.bytes).startsWith('% untouched\nBT /F1 10 Tf 50 200 Td ')).toBe(true);
      expect(text(result.bytes).endsWith(' (tail) Tj 0 -20 Td (next) Tj ET\n% end')).toBe(true);
    });
  }
  test('Tc/Tw/Tz under rotated CTM and q/Q preserve downstream and line matrices', () => {
    const s = bytes('q 0 1 -1 0 300 0 cm BT /F1 18 Tf 2 Tc 4 Tw 73 Tz 20 TL 72 640 Td (Tracked words here) Tj (Z) Tj T* (Q) Tj ET Q');
    const out = compile(s, [edit(s, 'Tracked words here', 'Tracked words gone')]);
    expect(out.ok).toBe(true);
    const a = positions(s).slice(-2), b = positions(out.bytes).slice(-2);
    b.forEach((p, i) => { expect(p.x).toBeCloseTo(a[i]!.x, 8); expect(p.y).toBeCloseTo(a[i]!.y, 8); });
  });
  test('two-byte CID 32 does not receive Tw', () => {
    const f = { ...font, bytesPerCode: 2 as const, unicodeByCode: new Map([[32, ' '], [65, 'A'], [66, 'B']]) };
    const s = bytes('BT /F1 10 Tf 4 Tw <00410020> Tj <0042> Tj ET');
    const e: RunEdit = { opIndex: 3, itemIndex: -1, fontResource: 'F1', fontObject: '7 0 R', byteStart: 0, byteEnd: 4, expected: new Uint8Array([0,65,0,32]), replacement: 'A' };
    const out = replaceRuns(s, [f], { sourceHash: sourceFingerprint(s), edits: [e] });
    expect(out.ok).toBe(true);
    expect(positions(out.bytes, f).at(-1)).toEqual(positions(s, f).at(-1));
  });
  test('repeated text edits only the addressed instance', () => {
    const s = bytes('BT /F1 10 Tf (same) Tj (same) Tj ET');
    const out = compile(s, [edit(s, 'same', 'else', 1)]);
    expect(out.ok).toBe(true);
    expect(text(out.bytes)).toContain('(same) Tj');
    expect(positions(out.bytes).map(g => String.fromCharCode(g.code)).join('')).toBe('sameelse');
  });
  for (const corrupt of [
    { fontObject: '8 0 R' }, { fontResource: 'F2' }, { opIndex: 0 },
    { itemIndex: 9 }, { byteStart: 1 }, { byteEnd: 2 }, { expected: bytes('Wrong') },
    { replacement: '☃' }, { replacement: 'line\nbreak' },
  ]) test(`refuses stale/unsupported address ${Object.keys(corrupt)}`, () => {
    refused(source, compile(source, [{ ...edit(source, 'Hello', 'Hi'), ...corrupt }]));
  });
  test('stale hash, duplicate edits and failed multi-edit are atomic', () => {
    const e = edit(source, 'Hello', 'Hi');
    refused(source, compile(source, [e], { sourceHash: 'stale' }));
    refused(source, compile(source, [e, e]));
    refused(source, compile(source, [e, { ...edit(source, ' suffix', '☃') }]));
  });
  for (const s of [
    'BT /F1 10 Tf (Hello) \' ET', 'BT /F1 10 Tf 2 3 (Hello) " ET',
    'BT /F1 10 Tf 4 Tr (Hello) Tj ET', '0 0 1 1 re W n BT /F1 10 Tf (Hello) Tj ET',
    '/Span << /ActualText (secret) >> BDC BT /F1 10 Tf (Hello) Tj ET EMC',
    'BT /F1 10 Tf /GS gs (Hello) Tj ET', 'BT /F1 10 Tf 0 0 0 0 0 0 Tm (Hello) Tj ET',
  ]) test(`refuses unsafe context ${s}`, () => {
    const b = bytes(s); refused(b, compile(b, [edit(b, 'Hello', 'Hi')]));
  });
  test('form scope, malformed streams and unmapped original codes refuse unchanged', () => {
    refused(source, compile(source, [edit(source, 'Hello', 'Hi')], { scope: 'form' }));
    const malformed = bytes(text(source) + '\n nonsense');
    refused(malformed, compile(malformed, []));
    const f = { ...font, unicodeByCode: new Map([[72, 'H']]) };
    refused(source, replaceRuns(source, [f], { sourceHash: sourceFingerprint(source), edits: [edit(source, 'Hello', 'H')] }));
  });
  test('ambiguous Unicode codes refuse; untouched isolated clip/form contexts remain byte exact', () => {
    const f = { ...font, unicodeByCode: new Map([...font.unicodeByCode, [200, 'H']]) };
    refused(source, replaceRuns(source, [f], { sourceHash: sourceFingerprint(source), edits: [edit(source, 'Hello', 'Hi')] }));
    const s = bytes('q 0 0 20 20 re W n /Fm Do Q\nBT /F1 10 Tf (Hello) Tj ET');
    const out = compile(s, [edit(s, 'Hello', 'Hi')]);
    expect(out.ok).toBe(true);
    expect(text(out.bytes).startsWith('q 0 0 20 20 re W n /Fm Do Q\n')).toBe(true);
  });
});

test('refuses zero horizontal scale and nonfinite transformed geometry', () => {
  for (const prefix of ['0 Tz', `${'1' + '0'.repeat(308)} 0 0 1 0 0 cm`]) {
    const s = bytes(`BT /F1 10 Tf ${prefix} (Hello) Tj ET`);
    refused(s, compile(s, [edit(s, 'Hello', 'Hi')]));
  }
});
