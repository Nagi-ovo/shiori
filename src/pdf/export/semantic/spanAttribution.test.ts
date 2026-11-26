import { expect, test } from 'bun:test';
import { PDFDocument, PDFName } from 'pdf-lib';
import { exportPdf } from '../exportPdf';
import { fixture, model, overlay } from '../contentText/fixtures.test-support';
import { glyphText, inReadingOrder } from './editIntent';
import { createSemanticInspector } from './inspection';

const mark = (id: number, contents: string) => `/Span << /MCID ${id} >> BDC ${contents} EMC`;
const isolated = (id: number, contents: string, x: number, y: number) =>
  mark(id, `q BT /F1 10 Tf 1 0 0 1 ${x} ${y} Tm (${contents}) Tj ET Q`);
const cell = (y: number) => ({ x: 49, y: y - 3, w: 10, h: 13 });
const line = { x: 49, y: 98, w: 26, h: 13 };
async function spans(bytes: Uint8Array) {
  const page = createSemanticInspector(await PDFDocument.load(bytes)).inspectPage(0)!;
  return page.occurrences.flatMap(o => o.spans.map(s => [
    s.mcid, o.stream, glyphText(inReadingOrder(s.glyphs)), s.glyphs.map(g => g.placement.coreQuad[0]),
  ]));
}

// The cover can contain independent MCIDs. Only the scoped replacement
// should be written, even with two separate changes and a literal space.
test('edits one horizontal span in a wider cover with an explicit-space sibling', async () => {
  const { doc } = await fixture(`BT /F1 10 Tf 50 100 Td ${mark(0, '(A) Tj')} ${mark(1, '( ) Tj')} ${mark(2, '(BCD) Tj')} ET`);
  const source = await doc.save();
  const edit = overlay({ originalText: 'A BCD', text: 'A XCY' });
  const out = await exportPdf(source, model([edit]));
  expect(out.contentTextOutcomes?.[0]?.mode).not.toBe('unsupported');
  expect(out.semanticChanges).toMatchObject([{ dependency: { mcid: 2 }, action: 'preserved' }]);
  const before = await spans(source), after = await spans(out.bytes);
  expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
  expect(after[2]?.slice(0, 3)).toEqual([2, 'page', 'XCY']);
});

test('edits one upright span in a multi-span column', async () => {
  const show = (y: number, text: string) => `1 0 0 1 50 ${y} Tm (${text}) Tj`;
  const { doc } = await fixture(`BT /F1 10 Tf ${mark(0, show(150, '!'))} ${mark(1, show(135, '?') + ' ' + show(120, '+'))} ${mark(2, show(105, '-'))} ET`);
  const source = await doc.save();
  const edit = overlay({ originalText: '!?+-', text: '!+?-', coverRects: [150, 135, 120, 105].map(cell) });
  const out = await exportPdf(source, model([edit]));
  expect(out.contentTextOutcomes?.[0]?.mode).toBe('retypeset');
  const before = await spans(source), after = await spans(out.bytes);
  expect(after[0]).toEqual(before[0]);
  expect(after[2]).toEqual(before[2]);
  expect(after[1]?.slice(0, 3)).toEqual([1, 'page', '+?']);
});

test('an insertion inside a sibling item refuses a crossing even with an unchanged glyph run', async () => {
  const { doc } = await fixture(`${isolated(0, 'X', 50, 100)} ${isolated(1, 'ABC', 56, 100)}`);
  const source = await doc.save();
  const edit = overlay({ originalText: 'XABC', text: 'ABXC', coverRects: [line] });
  const out = await exportPdf(source, model([edit]));
  expect(out.contentTextOutcomes).toMatchObject([{ mode: 'unsupported', reason: 'semantic-dependency' }]);
  expect(out.semanticChanges?.map(row => row.reason)).toEqual(['semantic-partial-span', 'semantic-partial-span']);
  expect(out.bytes).toEqual(source);
});

test('rotates complete isolated column items and preserves the unaffected item', async () => {
  const { doc } = await fixture(['!', '?', '+', '-'].map((c, i) => isolated(i, c, 50, 150 - 15 * i)).join('\n'));
  const source = await doc.save();
  const edit = overlay({ originalText: '!?+-', text: '?+!-', coverRects: [150, 135, 120, 105].map(cell) });
  const out = await exportPdf(source, model([edit]));
  expect(out.contentTextOutcomes).toMatchObject([{ mode: 'retypeset' }]);
  const before = await spans(source), after = await spans(out.bytes);
  expect(after).toEqual([
    [1, 'page', '?', [{ x: 50, y: 150 }]],
    [2, 'page', '+', [{ x: 50, y: 135 }]],
    [0, 'page', '!', [{ x: 50, y: 120 }]],
    before[3],
  ]);
});

test('an explicit space owned by a sibling prevents moving one glyph past it', async () => {
  const { doc } = await fixture(`${isolated(0, 'A!', 50, 100)} ${isolated(1, ' ', 62, 100)} ${isolated(2, 'B', 68, 100)}`);
  const source = await doc.save();
  const edit = overlay({ originalText: 'A! B', text: '! AB', coverRects: [line] });
  const out = await exportPdf(source, model([edit]));
  expect(out.contentTextOutcomes).toMatchObject([{ mode: 'unsupported', reason: 'semantic-dependency' }]);
  expect(out.semanticChanges?.map(row => [row.dependency.mcid, row.reason])).toEqual([
    [0, 'semantic-partial-span'], [1, 'semantic-partial-span'],
  ]);
  expect(out.bytes).toEqual(source);
});

test('a complete item move refuses when the tagged structure fixes extraction order', async () => {
  const { doc, page } = await fixture(['!', '?', '+', '-'].map((c, i) => isolated(i, c, 50, 150 - 15 * i)).join('\n'));
  const ctx = doc.context;
  const name = PDFName.of;
  const root = ctx.nextRef(), owner = ctx.register(ctx.obj({ S: 'P', P: root, Pg: page.ref, K: [0, 1, 2, 3] }));
  ctx.assign(root, ctx.obj({ Type: 'StructTreeRoot', K: owner, ParentTree: { Nums: [0, [owner, owner, owner, owner]] } }));
  doc.catalog.set(name('StructTreeRoot'), root);
  page.node.set(name('StructParents'), ctx.obj(0));
  const source = await doc.save();
  const edit = overlay({ originalText: '!?+-', text: '?+!-', coverRects: [150, 135, 120, 105].map(cell) });
  const out = await exportPdf(source, model([edit]));
  expect(out.contentTextOutcomes).toMatchObject([{ mode: 'unsupported', reason: 'semantic-dependency' }]);
  expect(out.semanticChanges?.map(row => row.reason)).toEqual(Array(3).fill('semantic-partial-span'));
  expect(out.bytes).toEqual(source);
});
