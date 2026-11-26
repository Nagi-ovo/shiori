import { describe, expect, test } from 'bun:test';
import { detectParagraphRegion, stage5Reflow, type ParagraphInput, type RegionProof } from './regionProof';
import { moveLine, paragraph } from './regionProof.fixtures';

function proof(input = paragraph()): RegionProof {
  const result = detectParagraphRegion(input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw Error(result.reason);
  return result.proof;
}
function refuses(input: ParagraphInput, blocker?: string) {
  const result = detectParagraphRegion(input);
  expect(result).toMatchObject({ ok: false, code: 'reflow-paragraph-unproven', family: 'reflow-required' });
  if (!result.ok && blocker) expect(result.blocker).toBe(blocker);
}

// Failure inventory is recorded in STATUS-paragraph.md before implementation.
describe('paragraph geometry and capacity', () => {
  test('flush proof owns source addresses and a ragged final line', () => {
    const p = proof();
    expect(p.indent).toEqual({ kind: 'flush', amountPt: 0 });
    expect(p.lineSlots).toEqual([700, 686, 672].map(baseline =>
      ({ baseline, left: 50, right: 150, kind: 'observed' })));
    expect(p.box).toEqual({ x: 50, y: 670, w: 100, h: 38 });
    expect(p.owned).toHaveLength(3);
    expect(p.leadingPt).toBe(14);
  });
  test.each([10, 20, 20.04, 24, 17.3])('first-line indent of %s pt preserves its own capacity', amount => {
    const p = proof(paragraph([50 + amount, 50, 50]));
    expect(p.indent.kind).toBe('first-line');
    expect(p.indent.amountPt).toBeCloseTo(amount, 8);
    expect(p.lineSlots[0]!.left).toBe(50 + amount);
    expect(p.lineSlots[0]!.right - p.lineSlots[0]!.left).toBe(100 - amount);
    expect(p.lineSlots[1]!.left).toBe(50);
    expect(p.box.x).toBe(50);
    if (amount === 10 || amount === 20.04) expect(p.indent.emMultiple).toBe(amount === 10 ? 1 : 2);
  });
  test('hanging indent keeps the wider first line and narrower body', () => {
    const p = proof(paragraph([30, 50, 50]));
    expect(p.indent).toEqual({ kind: 'hanging', amountPt: 20, emMultiple: 2 });
    expect(p.lineSlots.map(s => s.left)).toEqual([30, 50, 50]);
  });
  test('proof is independent from caller mutation', () => {
    const input = paragraph([74, 50, 50]);
    const p = proof(input);
    input.lines[0]!.shows[0]!.source.byteEnd = 999;
    expect(p.owned[0]!.byteEnd).toBe(3);
    expect(p.lineSlots[0]!.left).toBe(74);
  });
  test('uses conservative matched left/right edges without stealing first capacity', () => {
    const input = paragraph([74, 50, 50.2], [150, 150.4, 115]);
    // Original ink must already fit the conservative edge: endpoint includes trailing spacing.
    input.lines[1]!.ink!.w -= 0.4;
    const p = proof(input);
    expect(p.lineSlots.map(s => s.left)).toEqual([74, 50.2, 50.2]);
    expect(p.lineSlots.map(s => s.right)).toEqual([150, 150, 150]);
    expect(p.box.x).toBe(50);
  });
  test.each([[50, 70, 50], [74, 50, 60], [74, 50, 50, 74]].map(lefts => [lefts]))('inconsistent body pattern %j refuses', lefts => {
    refuses(paragraph(lefts), 'edges');
  });
  test('left tolerance is inclusive at 0.25 pt for 10 pt em', () => {
    const input = paragraph([50, 50, 50.25]);
    expect(proof(input).indent.kind).toBe('flush');
    refuses(paragraph([50, 50, 50.251]), 'edges');
  });
  test('right tolerance is inclusive at 0.5 pt for 10 pt em', () => {
    const input = paragraph([50, 50, 50], [150, 150.5, 115]);
    input.lines[1]!.ink!.w -= 0.5;
    expect(proof(input).lineSlots[0]!.right).toBe(150);
    refuses(paragraph([50, 50, 50], [150, 150.501, 115]), 'edges');
  });
  test('ink and ragged final endpoint cannot expand the proven right edge', () => {
    refuses(paragraph([50, 50, 50], [150, 150, 160]), 'edges');
    const input = paragraph(); input.lines[1]!.ink!.w += 0.1;
    refuses(input, 'bounds');
  });
  test('raster guard is capped and does not grow horizontal capacity', () => {
    const input = paragraph(); input.rasterGuardPt = 0.5;
    expect(proof(input).box).toEqual({ x: 50, y: 669.5, w: 100, h: 39 });
    input.rasterGuardPt = 0.501; refuses(input, 'bounds');
  });
});

describe('source, state and paragraph evidence', () => {
  test('requires at least three nonempty lines, not two aligned labels', () => {
    refuses(paragraph([50, 50]), 'lines');
    const input = paragraph(); input.evidence.structure = 'labels'; refuses(input, 'boundary');
  });
  test.each(['table', 'caption', 'unknown'] as const)('%s is not a body paragraph', structure => {
    const input = paragraph(); input.evidence.structure = structure; refuses(input, 'boundary');
  });
  test.each(['readingOrder', 'whitespace', 'columnBoundary', 'semantics'] as const)('requires proven %s', key => {
    const input = paragraph();
    if (key === 'readingOrder') input.evidence[key] = 'ambiguous';
    if (key === 'whitespace') input.evidence[key] = 'inferred';
    if (key === 'columnBoundary') input.evidence[key] = 'uncertain';
    if (key === 'semantics') input.evidence[key] = 'unresolved';
    refuses(input);
  });
  test('same MCID with unresolved ActualText/Alt/E is insufficient', () => {
    const input = paragraph(); input.evidence.semantics = 'unresolved'; refuses(input, 'semantics');
    input.evidence.semantics = 'redistribution-proven'; expect(proof(input).bt).toBe(0);
  });
  test('rejects stale scene revision and missing obstacle/boundary evidence', () => {
    for (const key of ['sourceHash', 'dependencyHash', 'obstacleProofHash', 'boundaryProofHash'] as const) {
      const input = paragraph(); input.evidence[key] = ''; refuses(input);
    }
  });
  test.each(['size', 'tz', 'rise', 'renderMode', 'safetyHash', 'bt'] as const)(
    'mixed %s refuses', key => {
      const input = paragraph();
      for (const t of [input.lines[1]!.anchor, input.lines[1]!.shows[0]!.before, input.lines[1]!.shows[0]!.after]) {
        if (key === 'safetyHash') t[key] = 'different';
        else t[key] += key === 'size' ? 0.051 : 1;
      }
      refuses(input, 'state');
    });
  test('paragraph members may change font and justification spacing', () => {
    const input = paragraph(), line = input.lines[1]!;
    for (const t of [line.anchor, line.shows[0]!.before, line.shows[0]!.after]) {
      t.fontObject = '8 0 R'; t.tc = 0.1; t.tw = -0.3;
    }
    line.shows[0]!.source.fontObject = '8 0 R';
    expect(proof(input).owned[1]!.fontObject).toBe('8 0 R');
  });
  test('physical size tolerance is 0.05 pt and handles matrix-scaled Tf', () => {
    const input = paragraph();
    for (const t of [input.lines[1]!.anchor, input.lines[1]!.shows[0]!.before, input.lines[1]!.shows[0]!.after]) t.size = 10.05;
    expect(proof(input).kind).toBe('paragraph');
    for (const line of input.lines) for (const t of [line.anchor, ...line.shows.flatMap(s => [s.before, s.after])]) {
      t.size = 1; t.tm = [10, 0, 0, 10, t.tm[4]!, t.tm[5]!];
      t.tlm = [10, 0, 0, 10, t.tlm[4]!, t.tlm[5]!]; t.leading = 1.4;
    }
    for (const line of input.lines) input.ops[line.anchor.opIndex]!.operands.splice(0, 4,
      ...[10, 0, 0, 10].map(value => ({ kind: 'number' as const, value })));
    expect(proof(input).leadingPt).toBeCloseTo(14);
  });
  test('skew, rotated, reflected and nonfinite transforms refuse', () => {
    for (const [a, b] of [[0, 1], [-1, 0], [NaN, 0]]) {
      const input = paragraph(); input.lines[0]!.shows[0]!.before.tm = [a!, b!, 0, 1, 50, 700];
      refuses(input, 'state');
    }
  });
  test('source order and show byte ownership must be complete', () => {
    const input = paragraph(); input.lines.reverse(); refuses(input);
    const partial = paragraph(); partial.lines[1]!.shows[0]!.source.byteEnd = 2; refuses(partial, 'ownership');
    const unknown = paragraph(); unknown.lines[1]!.shows = []; refuses(unknown);
  });
  test.each(["'", '"', 'gs', 'q', 'Q', 'rg', 'W', 'S', 'Do', 'UNKNOWN'])(
    'interleaved %s is refused', operator => {
      const input = paragraph(); input.ops[input.lines[1]!.anchor.opIndex]!.operator = operator;
      refuses(input, 'operators');
    });
  test('column interleaving is not recovered by sorting rows', () => {
    const input = paragraph(); moveLine(input, 1, 200); refuses(input, 'edges');
  });
  test('RTL and bidi controls refuse', () => {
    for (const unicode of ['שלום', 'مرحبا', 'abc\u202Edef', 'abc\u2067def']) {
      const input = paragraph(); input.lines[0]!.shows[0]!.unicode = unicode; refuses(input, 'direction');
    }
  });
  test('local TJ kerns stay attached to their original source boundary', () => {
    const input = paragraph(); const line = input.lines[1]!, show = line.shows[0]!;
    input.ops[show.source.opIndex]!.operator = 'TJ';
    input.ops[show.source.opIndex]!.operands = [{ kind: 'array', items: [
      { kind: 'string', bytes: new Uint8Array([97, 98, 99]) }, { kind: 'number', value: -30 },
      { kind: 'string', bytes: new Uint8Array([100, 101, 102]) },
    ] }];
    show.source.itemIndex = 0; show.after.tm = [1, 0, 0, 1, 99.7, 686];
    const next = structuredClone(show); next.source.itemIndex = 2;
    next.before.tm = [1, 0, 0, 1, 100, 686]; next.after.tm = [1, 0, 0, 1, 150, 686];
    line.shows.push(next);
    const p = proof(input);
    expect(p.tjBoundaries).toEqual([{ opIndex: 6, itemIndex: 1, value: -30,
      left: show.source, right: next.source }]);
  });
});

describe('leading, slots and obstacles', () => {
  test('explicit TL and observed advances agree within 0.14 pt', () => {
    const input = paragraph(); moveLine(input, 2, 0, -0.14); proof(input);
    moveLine(input, 2, 0, -0.001); refuses(input, 'leading');
  });
  test('observed leading works without TL; no extra blank from a large gap', () => {
    const input = paragraph();
    for (const l of input.lines) for (const t of [l.anchor, ...l.shows.flatMap(s => [s.before, s.after])]) t.leading = 0;
    input.ops[2]!.operands = [{ kind: 'number', value: 0 }];
    expect(proof(input).leadingPt).toBe(14);
    moveLine(input, 2, 0, -14); refuses(input, 'leading');
  });
  test('explicit blank baseline is a slot only inside the observed box', () => {
    const input = paragraph([50, 50, 50, 50], [150, 150, 150, 115]);
    const blank = input.lines[1]!;
    blank.shows = []; blank.ink = null;
    input.ops[blank.anchor.opIndex + 1]!.operands = [{ kind: 'string', bytes: new Uint8Array() }];
    const p = proof(input);
    expect(p.lineSlots).toHaveLength(4);
    expect(p.lineSlots[1]!.kind).toBe('explicit-blank');
    input.lines[3]!.shows = []; input.lines[3]!.ink = null; refuses(input, 'lines');
  });
  test('vertical ink overlap refuses even with regular leading', () => {
    const input = paragraph(); input.lines[1]!.ink!.h = 15; refuses(input, 'bounds');
  });
  test('intersecting text, annotations, paint, unknown bounds and incomplete scene refuse', () => {
    for (const kind of ['text', 'annotation', 'paint'] as const) {
      const input = paragraph(); input.evidence.obstacles = [{ kind, box: { x: 55, y: 675, w: 5, h: 5 } }];
      refuses(input, 'obstacles');
    }
    const input = paragraph(); input.evidence.obstacles = [{ kind: 'paint', box: null }]; refuses(input, 'obstacles');
    input.evidence.obstacles = []; input.evidence.completeScene = false; refuses(input, 'obstacles');
  });
  test('only a proved stationary full backdrop may intersect', () => {
    const input = paragraph(); input.evidence.obstacles = [{ kind: 'stationary-backdrop',
      box: { x: 0, y: 0, w: 600, h: 800 }, proofHash: 'uniform-unchanged' }]; proof(input);
    input.evidence.obstacles[0]!.proofHash = ''; refuses(input, 'obstacles');
  });
  test('box stays within crop and clip, with no bottom extension', () => {
    const input = paragraph(); input.evidence.clip = { x: 0, y: 675, w: 600, h: 125 }; refuses(input, 'bounds');
    const p = proof(); expect(p.lineSlots.at(-1)!.baseline).toBe(672); expect(p.box.y).toBe(670);
  });
  test('all stage-5 policies remain default-off', () => {
    expect(stage5Reflow).toEqual({ paragraphDetection: false, spacingOnly: false, boundedReflow: false });
  });
});
