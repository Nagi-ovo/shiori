import { expect, test } from 'bun:test';
import { detectParagraphRegion } from './regionProof';
import { paragraph } from './regionProof.fixtures';

test('a show cannot steal a different first origin from its encoded anchor', () => {
  const input = paragraph([74, 50, 50]);
  input.lines[0]!.shows[0]!.before.tm = [1, 0, 0, 1, 50, 700];
  expect(detectParagraphRegion(input)).toMatchObject({ ok: false, blocker: 'state' });
});
test('local TJ numbers must agree with both string snapshots', () => {
  const input = paragraph(); const line = input.lines[1]!, a = line.shows[0]!;
  input.ops[a.source.opIndex]!.operator = 'TJ';
  input.ops[a.source.opIndex]!.operands = [{ kind: 'array', items: [
    { kind: 'string', bytes: new Uint8Array(3) }, { kind: 'number', value: -30 },
    { kind: 'string', bytes: new Uint8Array(3) },
  ] }];
  a.source.itemIndex = 0; a.after.tm = [1, 0, 0, 1, 100, 686];
  const b = structuredClone(a); b.source.itemIndex = 2;
  b.before.tm = [1, 0, 0, 1, 110, 686]; b.after.tm = [1, 0, 0, 1, 150, 686];
  line.shows.push(b);
  expect(detectParagraphRegion(input)).toMatchObject({ ok: false, blocker: 'state' });
});
test('encoded trailing TJ displacement cannot silently enlarge the right edge', () => {
  const input = paragraph(); const a = input.lines[1]!.shows[0]!;
  input.ops[a.source.opIndex]!.operator = 'TJ'; a.source.itemIndex = 0;
  input.ops[a.source.opIndex]!.operands = [{ kind: 'array', items: [
    { kind: 'string', bytes: new Uint8Array(3) }, { kind: 'number', value: -200 },
  ] }];
  expect(detectParagraphRegion(input)).toMatchObject({ ok: false, blocker: 'edges' });
});
test('subsequent Td/TD/T* anchors use saved Tlm and physical leading', () => {
  for (const operator of ['Td', 'TD', 'T*']) {
    const input = paragraph();
    for (const line of input.lines.slice(1)) {
      const op = input.ops[line.anchor.opIndex]!; op.operator = operator;
      op.operands = operator === 'T*' ? [] : [0, -14].map(value => ({ kind: 'number', value }));
    }
    expect(detectParagraphRegion(input).ok).toBe(true);
    input.lines[2]!.anchor.tlm = [1, 0, 0, 1, 50, 671];
    expect(detectParagraphRegion(input).ok).toBe(false);
  }
});
test('large coordinates do not turn one-point anchor drift into a match', () => {
  const input = paragraph([1_000_050, 1_000_050, 1_000_050], [1_000_150, 1_000_150, 1_000_115]);
  input.evidence.crop.w = 2_000_000; input.evidence.clip.w = 2_000_000;
  // The trace claims x=1,000,050; the encoded Tm actually says x=1,000,049.
  input.ops[input.lines[0]!.anchor.opIndex]!.operands[4] = { kind: 'number', value: 1_000_049 };
  expect(detectParagraphRegion(input)).toMatchObject({ ok: false, blocker: 'operators' });
});
test('a large TJ cannot reverse source show reading order', () => {
  const input = paragraph(); const line = input.lines[1]!, a = line.shows[0]!;
  input.ops[a.source.opIndex]!.operator = 'TJ';
  input.ops[a.source.opIndex]!.operands = [{ kind: 'array', items: [
    { kind: 'string', bytes: new Uint8Array(3) }, { kind: 'number', value: 6000 },
    { kind: 'string', bytes: new Uint8Array(3) },
  ] }];
  a.source.itemIndex = 0; a.after.tm = [1, 0, 0, 1, 100, 686];
  const b = structuredClone(a); b.source.itemIndex = 2;
  b.before.tm = [1, 0, 0, 1, 40, 686]; b.after.tm = [1, 0, 0, 1, 150, 686];
  line.shows.push(b);
  expect(detectParagraphRegion(input)).toMatchObject({ ok: false, blocker: 'state' });
});
test('explicit inline math/superscript evidence is not plain paragraph text', () => {
  const input = paragraph(); input.evidence.inlineFeatures = 'math-or-superscript';
  expect(detectParagraphRegion(input)).toMatchObject({ ok: false, blocker: 'semantics' });
});
test('a leading TJ indent uses the first actual show origin for slot capacity', () => {
  const input = paragraph(); const line = input.lines[0]!, a = line.shows[0]!;
  input.ops[a.source.opIndex]!.operator = 'TJ'; a.source.itemIndex = 1;
  input.ops[a.source.opIndex]!.operands = [{ kind: 'array', items: [
    { kind: 'number', value: -2400 }, { kind: 'string', bytes: new Uint8Array(3) },
  ] }];
  a.before.tm = [1, 0, 0, 1, 74, 700]; line.ink!.x = 74; line.ink!.w = 76;
  const result = detectParagraphRegion(input);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.proof.indent).toMatchObject({ kind: 'first-line', amountPt: 24 });
    expect(result.proof.lineSlots[0]!.left).toBe(74);
    expect(result.proof.lineSlots[1]!.left).toBe(50);
  }
});
test('a small negative source kern is retained without changing show order', () => {
  const input = paragraph(); const line = input.lines[1]!, a = line.shows[0]!;
  input.ops[a.source.opIndex]!.operator = 'TJ'; a.source.itemIndex = 0;
  input.ops[a.source.opIndex]!.operands = [{ kind: 'array', items: [
    { kind: 'string', bytes: new Uint8Array(3) }, { kind: 'number', value: 30 },
    { kind: 'string', bytes: new Uint8Array(3) },
  ] }];
  a.after.tm = [1, 0, 0, 1, 100.3, 686];
  const b = structuredClone(a); b.source.itemIndex = 2;
  b.before.tm = [1, 0, 0, 1, 100, 686]; b.after.tm = [1, 0, 0, 1, 150, 686]; line.shows.push(b);
  const result = detectParagraphRegion(input);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.proof.tjBoundaries[0]!.value).toBe(30);
});
