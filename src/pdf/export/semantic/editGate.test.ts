import { expect, test } from 'bun:test';
import { PDFDict, PDFDocument, PDFHexString, PDFName } from 'pdf-lib';
import { buildContentTextPreview } from '../../../editor/components/contentTextPreview';
import { renderFixtureRegion } from '../../../../scripts/pdf-inplace/fixtureRaster.test-support';
import { exportPdf } from '../exportPdf';
import { inventorySemantics } from '../semanticGate';
import { createSemanticInspector } from './inspection';
import { glyphText } from './editIntent';
import { inspectRunPage } from '../contentStreamEdit/replaceRunPage';
import { fixture, model, overlay } from '../contentText/fixtures.test-support';

const name = PDFName.of;
const row = (id: string, originalText: string, text: string, x: number, y: number) => {
  const rect = { x: x - .01, y: y - 2, w: originalText.length * 6 + .02, h: 13 };
  return overlay({ id, originalText, text, rect, coverRects: [rect] });
};
const show = (text: string, y: number) => `BT /F1 10 Tf 50 ${y} Td (${text}) Tj ET`;

async function tag(input: Awaited<ReturnType<typeof fixture>>, ids: number[], bad?: number, explicit?: number) {
  const { doc, page } = input, ctx = doc.context, root = ctx.nextRef();
  const owners = ids.map(id => ctx.register(ctx.obj({
    S: 'P', P: root, Pg: page.ref, K: id === explicit
      ? { Type: 'MCR', MCID: id, Stm: page.node.get(name('Contents')), StmOwn: page.ref }
      : id,
  })));
  const slots = Array.from({ length: Math.max(...ids) + 1 }, (_, id) => id === bad ? null : owners[ids.indexOf(id)] ?? null);
  ctx.assign(root, ctx.obj({ Type: 'StructTreeRoot', K: owners, ParentTree: { Nums: [9, slots] } }));
  page.node.set(name('StructParents'), ctx.obj(9));
  doc.catalog.set(name('StructTreeRoot'), root);
  return owners;
}

test('reports a valid MCID and refuses a broken sibling without rejecting free text', async () => {
  const input = await fixture([
    '/P << /MCID 0 >> BDC', show('ABCDE', 150), 'EMC',
    '/P << /MCID 1 >> BDC', show('FGHIJ', 100), 'EMC', show('KLMNO', 50),
  ].join('\n'));
  const [owner] = await tag(input, [0, 1], 1);
  const source = await input.doc.save();
  const edits = [
    row('valid', 'B', 'X', 56, 150),
    row('broken', 'FGHIJ', 'FGTIJ', 50, 100),
    row('free', 'KLMNO', 'KLMTO', 50, 50),
  ];
  const out = await exportPdf(source, model(edits), { acceptance: 'strict' });
  expect(out.contentTextOutcomes?.map(({ overlayId, reason }) => [overlayId, reason]))
    .toEqual([['valid', undefined], ['broken', 'semantic-dependency'], ['free', undefined]]);
  expect(out.semanticChanges?.toSorted((a, b) => b.overlayId.localeCompare(a.overlayId))).toEqual([
    expect.objectContaining({ overlayId: 'valid', action: 'preserved', dependency: expect.objectContaining({
      kind: 'mcid', mcid: 0, stream: 'page', pageIndex: 0, structElem: owner!.toString(),
    }) }),
    expect.objectContaining({ overlayId: 'broken', action: 'refused', reason: 'semantic-unresolved' }),
  ]);
});

test('refuses an uncovered write when coalescing removes an explicit MCR stream', async () => {
  const input = await fixture(`/P << /MCID 0 >> BDC ${show('ABCDE', 150)} EMC ${show('FGHIJ', 100)}`);
  await tag(input, [0], undefined, 0);
  const source = await input.doc.save();
  const out = await exportPdf(source, model([row('free', 'FGHIJ', 'FGTIJ', 50, 100)]));
  expect(out.contentTextOutcomes).toMatchObject([{ mode: 'unsupported', reason: 'semantic-dependency' }]);
  expect(out.semanticChanges).toContainEqual(expect.objectContaining({
    overlayId: 'free', action: 'refused', reason: 'semantic-structure-reference',
    dependency: expect.objectContaining({ kind: 'mcr-stm', mcid: 0 }),
  }));
  expect(out.bytes).toEqual(source);
});

// A successful stream compilation can still invalidate an explicit MCR
// reference. An unrelated source anchor must not hide that existing refusal.
test('semantic verification keeps precedence over a source annotation anchor', async () => {
  const input = await fixture(`/P << /MCID 0 >> BDC ${show('ABCDE', 150)} EMC ${show('FGHIJ', 100)}`);
  await tag(input, [0], undefined, 0);
  const edit = row('free', 'FGHIJ', 'The caption grows beyond its original width', 50, 100);
  const options = { stage5Reflow: false, preserveSourceAnnotations: true };
  const control = await exportPdf(await input.doc.save(), model([edit]), options);
  expect(control.contentTextOutcomes).toMatchObject([{ mode: 'unsupported', reason: 'semantic-dependency' }]);

  input.page.node.set(name('Annots'), input.doc.context.obj([{ Subtype: 'Link', Rect: [52, 100, 62, 106] }]));
  const source = await input.doc.save();
  const out = await exportPdf(source, model([edit]), options);
  expect(out.contentTextOutcomes).toEqual(control.contentTextOutcomes!);
  expect(out.semanticChanges).toEqual(control.semanticChanges!);
  expect(out.bytes).toEqual(source);
});

test('a broken MCR only refuses edits that touch the unresolved span', async () => {
  const input = await fixture(`/P << /MCID 0 >> BDC ${show('ABCDE', 150)} EMC ${show('FGHIJ', 100)}`);
  const [owner] = await tag(input, [0], undefined, 0);
  const ctx = input.doc.context;
  const broken = ctx.register(ctx.stream(''));
  ctx.lookup(owner!, PDFDict).lookup(name('K'), PDFDict).set(name('Stm'), broken);
  const source = await input.doc.save();
  const out = await exportPdf(source, model([
    row('marked', 'ABCDE', 'AXCDE', 50, 150),
    row('free', 'FGHIJ', 'FGTIJ', 50, 100),
  ]));
  expect(out.contentTextOutcomes).toMatchObject([
    { overlayId: 'marked', mode: 'unsupported', reason: 'semantic-dependency' },
    { overlayId: 'free', mode: 'in-place' },
  ]);
  expect(out.semanticChanges).toContainEqual(expect.objectContaining({
    overlayId: 'marked', action: 'refused', reason: 'semantic-unresolved',
    dependency: expect.objectContaining({ kind: 'mcr-stm', stream: broken.toString() }),
  }));
  expect(out.semanticChanges?.map(change => change.overlayId)).not.toContain('free');
});

test('refuses partial untagged replacement text even if a retypeset would strip it', async () => {
  const input = await fixture(`/Span << /ActualText (Readable label) >> BDC ${show('ABCDE', 100)} EMC`);
  const source = await input.doc.save();
  const out = await exportPdf(source, model([row('partial', 'BCD', 'ZZ', 56, 100)]));
  expect(out.contentTextOutcomes).toMatchObject([{ mode: 'unsupported', reason: 'semantic-dependency' }]);
  expect(out.semanticChanges).toMatchObject([{ action: 'refused', reason: 'semantic-replacement-text' }]);
  const saved = await PDFDocument.load(out.bytes);
  expect(inspectRunPage(saved.getPage(0))).toMatchObject({ ok: true, bytes: input.source });
});

test('reads crop-local glyphs on a later source page in export and preview', async () => {
  const { doc, page: first } = await fixture();
  const page = doc.addPage([380, 260]);
  page.setCropBox(25, 10, 300, 200);
  page.node.set(name('Resources'), first.node.Resources()!);
  page.node.set(name('Contents'), doc.context.register(doc.context.stream(
    `q 1 0 0 1 25 10 cm /P << /MCID 0 >> BDC ${show('ABCDE', 100)} EMC Q`,
  )));
  await tag({ doc, page, source: new Uint8Array() }, [0]);
  const saved = await doc.save();
  const firstPage = model([]).pages[0]!;
  const later = { ...firstPage, id: 'later', sourceIndex: 1, originXPt: 25, originYPt: 10 };
  const target = { ...row('later-edit', 'B', 'X', 56, 100), pageId: later.id };
  const requested = { pages: [firstPage, later], overlays: [target] };
  const result = await exportPdf(saved, requested);
  const preview = await buildContentTextPreview(saved, later, [target]);
  expect(result.semanticChanges).toMatchObject([{
    overlayId: target.id, action: 'preserved', dependency: { pageIndex: 1, mcid: 0, bbox: { x: 50 } },
  }]);
  expect(preview.semanticChanges).toEqual(result.semanticChanges);
  expect(preview.pageIndex).toBe(1);
  expect(preview.bytes).not.toBeNull();
});

test('recompiles away an unsafe nested Form clone while retaining an independent page edit', async () => {
  const input = await fixture(`/Outer Do q 1 0 0 1 0 -60 cm /Outer Do Q ${show('FGHIJ', 25)}`);
  const { doc, page } = input, ctx = doc.context;
  const resources = page.node.Resources()!;
  const leaf = ctx.register(ctx.stream(`/P << /MCID 0 >> BDC ${show('ABCDE', 150)} EMC`, {
    Subtype: 'Form', BBox: [0, 0, 300, 200], StructParents: 9, Resources: resources.clone(),
  }));
  const outer = ctx.register(ctx.stream('/Leaf Do', {
    Subtype: 'Form', BBox: [0, 0, 300, 200], Resources: { XObject: { Leaf: leaf } },
  }));
  resources.set(name('XObject'), ctx.obj({ Outer: outer }));
  const tree = ctx.nextRef();
  const owner = ctx.register(ctx.obj({ S: 'P', P: tree, Pg: page.ref, K: {
    Type: 'MCR', MCID: 0, Stm: leaf, StmOwn: outer,
  } }));
  ctx.assign(tree, ctx.obj({ Type: 'StructTreeRoot', K: owner, ParentTree: { Nums: [9, [owner]] } }));
  doc.catalog.set(name('StructTreeRoot'), tree);
  const source = await doc.save();
  const free = row('free', 'FGHIJ', 'FGTIJ', 50, 25);
  const out = await exportPdf(source, model([row('form', 'ABCDE', 'AXBDE', 50, 150), free]));
  expect(out.contentTextOutcomes).toMatchObject([
    { overlayId: 'form', mode: 'unsupported', reason: 'semantic-dependency' },
    { overlayId: 'free', mode: 'in-place' },
  ]);
  expect(out.semanticChanges).toContainEqual(expect.objectContaining({
    overlayId: 'form', action: 'refused', reason: 'semantic-structure-reference',
    dependency: expect.objectContaining({ kind: 'mcr-stm', stream: leaf.toString(), structElem: owner.toString() }),
  }));
  const copiedPage = (await PDFDocument.load(out.bytes)).getPage(0);
  expect(copiedPage.node.Resources()!.lookup(name('XObject'), PDFDict).keys()).toEqual([name('Outer')]);
});

test.skipIf(!Bun.which('pdftoppm'))('strict discards installed rows for a collision and keeps a sibling refusal and MCID', async () => {
  const input = await fixture([
    '1 0 0 rg 50.75 104.5 1 1 re f 0 g',
    '/P << /MCID 0 >> BDC', show('I', 100), 'EMC',
    '/P << /MCID 1 >> BDC', show('ABCDE', 150), 'EMC',
    '/P << /MCID 2 >> BDC', show('FGHIJ', 50), 'EMC',
  ].join('\n'));
  await tag(input, [0, 1, 2], 2);
  const bytes = await input.doc.save();
  const changes = model([row('collision', 'I', 'X', 50, 100), row('valid', 'B', 'X', 56, 150), row('broken', 'G', 'T', 56, 50)]);
  const review = await exportPdf(bytes, changes, { renderContentText: renderFixtureRegion });
  expect(review.semanticChanges?.find(change => change.overlayId === 'collision')).toMatchObject({ action: 'preserved' });
  const strict = await exportPdf(bytes, changes, { acceptance: 'strict', renderContentText: renderFixtureRegion });
  expect(strict.contentTextOutcomes).toMatchObject([
    { overlayId: 'collision', mode: 'unsupported', reason: 'acceptance-strict' },
    { overlayId: 'valid', mode: 'in-place' },
    { overlayId: 'broken', mode: 'unsupported', reason: 'semantic-dependency' },
  ]);
  expect(strict.semanticChanges?.map(({ overlayId, action }) => [overlayId, action]).sort()).toEqual([
    ['broken', 'refused'], ['valid', 'preserved'],
  ]);
});

test('a duplicate StructParents key affects the addressed MCID across source pages only', async () => {
  const input = await fixture(`/P << /MCID 0 >> BDC ${show('ABCDE', 150)} EMC ${show('FGHIJ', 100)}`);
  const { doc } = input;
  const other = doc.addPage([300, 200]);
  other.node.set(name('StructParents'), doc.context.obj(9));
  await tag(input, [0]);
  const bytes = await doc.save();
  const requested = model([row('marked', 'ABCDE', 'AXCDE', 50, 150), row('free', 'FGHIJ', 'FGTIJ', 50, 100)]);
  requested.pages.push({ ...requested.pages[0]!, id: 'other', sourceIndex: 1 });
  const result = await exportPdf(bytes, requested);
  expect(result.contentTextOutcomes).toMatchObject([
    { overlayId: 'marked', mode: 'unsupported', reason: 'semantic-dependency' },
    { overlayId: 'free', mode: 'in-place' },
  ]);
  expect(result.semanticChanges).toMatchObject([{
    overlayId: 'marked', action: 'refused', reason: 'semantic-unresolved', dependency: { mcid: 0 },
  }]);
});

test('an encrypted refusal retains the ciphertext and reports source dependencies', async () => {
  const input = await fixture(`/Span << /E (Expanded label) >> BDC ${show('ABCDE', 100)} EMC`);
  const plain = await input.doc.save();
  const cipher = Uint8Array.of(1, 2, 3);
  const result = await exportPdf(cipher, model([row('partial', 'BCD', 'ZZZ', 56, 100)]), {
    acceptance: 'strict',
    sourceEncryption: {
      security: null,
      plaintext: async () => plain,
      encrypt: async () => { throw Error('Refusal rewrote the source ciphertext'); },
    },
  });
  expect(result.bytes).toEqual(cipher);
  expect(result.acceptance.status).toBe('refused');
  expect(result.semanticChanges).toMatchObject([{
    overlayId: 'partial', action: 'refused', reason: 'semantic-replacement-text',
    dependency: { kind: 'expansion', text: 'Expanded label', pageIndex: 0 },
  }]);
});

test('an expanded rewrite cannot strip the equivalent from an unselected tail', async () => {
  const { doc } = await fixture([
    'BT /F1 10 Tf 50 150 Td (ABCDE) Tj',
    '/Span << /Alt (Retained branch) >> BDC (FGHIJ) Tj EMC ET',
    show('KLMNO', 50),
  ].join('\n'));
  const bytes = await doc.save();
  const target = row('expand', 'ABCDE', 'LONG SENTENCE', 50, 150);
  const sibling = row('sibling', 'KLMNO', 'KLMTO', 50, 50);
  const exported = await exportPdf(bytes, model([target, sibling]), { stage5Reflow: false });
  expect(exported.contentTextOutcomes).toMatchObject([
    { overlayId: 'expand', mode: 'unsupported', reason: 'semantic-dependency' },
    { overlayId: 'sibling', mode: 'in-place' },
  ]);
  expect(exported.semanticChanges).toMatchObject([{
    overlayId: 'expand', action: 'refused', reason: 'semantic-replacement-text',
    dependency: { kind: 'alt', text: 'Retained branch' },
  }]);
});

test('a bare StructParents key does not create an owner requirement without a structure tree', async () => {
  const { doc, page } = await fixture(`/P << /MCID 0 >> BDC ${show('ABCDE', 100)} EMC`);
  page.node.set(name('StructParents'), doc.context.obj(9));
  const source = await doc.save();
  const result = await exportPdf(source, model([row('marked', 'B', 'X', 56, 100)]));
  expect(result.contentTextOutcomes).toMatchObject([{ mode: 'in-place' }]);
  expect(result.semanticChanges).toMatchObject([{ action: 'preserved', dependency: { mcid: 0 } }]);
});

test('a loose cover may include an unchanged space outside the edited MCID', async () => {
  const { doc } = await fixture(
    'BT /F1 10 Tf 50 100 Td /P << /MCID 0 >> BDC (ABCDE) Tj EMC ( F) Tj ET',
  );
  const edit = row('marked', 'ABCDE', 'AXCDE', 50, 100);
  edit.coverRects[0]!.w += 6;
  const result = await exportPdf(await doc.save(), model([edit]));
  expect(result.contentTextOutcomes).toMatchObject([{ mode: 'in-place' }]);
  expect(result.semanticChanges).toMatchObject([{ action: 'preserved', dependency: { mcid: 0 } }]);
});

test.each(['inline', 'properties', 'struct-elem'] as const)('updates a fully covered %s value in tagged text', async source => {
  const props = source === 'inline' ? '<< /MCID 0 /ActualText (Old label) >>' :
    source === 'properties' ? '/Label' : '<< /MCID 0 >>';
  const input = await fixture(`/P ${props} BDC ${show('ABCDE', 100)} EMC`);
  const [owner] = await tag(input, [0]);
  if (source === 'properties') {
    input.page.node.Resources()!.set(name('Properties'), input.doc.context.obj({ Label: { MCID: 0, Alt: PDFHexString.fromText('Old label') } }));
  } else if (source === 'struct-elem') {
    input.doc.context.lookup(owner!, PDFDict).set(name('E'), PDFHexString.fromText('Old label'));
  }
  const result = await exportPdf(await input.doc.save(), model([row('whole', 'ABCDE', 'AXCDE', 50, 100)]), { acceptance: 'strict' });
  expect(result.contentTextOutcomes?.[0]?.mode).not.toBe('unsupported');
  expect(result.semanticChanges).toContainEqual(expect.objectContaining({
    overlayId: 'whole', action: 'updated', dependency: expect.objectContaining({ source, text: 'Old label' }),
  }));
  if (source === 'properties') {
    const saved = await PDFDocument.load(result.bytes);
    const properties = saved.getPage(0).node.Resources()!.lookup(name('Properties'), PDFDict);
    expect(properties.keys()).toHaveLength(1);
    expect(properties.has(name('Label'))).toBe(false);
  }
  const dependencies = await inventorySemantics(result.bytes, 0);
  expect(dependencies.filter(d => d.kind !== 'mcid').map(d => d.text)).toEqual(['AXCDE']);
});

test('inserting a column cell keeps shifted glyphs under their original MCIDs', async () => {
  const cells = ['!', '?', '-'].map((char, mcid) =>
    `/P << /MCID ${mcid} >> BDC 1 0 0 1 50 ${150 - mcid * 15} Tm (${char}) Tj EMC`);
  const { doc } = await fixture(`BT /F1 10 Tf ${cells.join(' ')} ET`);
  const edit = overlay({ originalText: '!?-', text: '!!?-',
    coverRects: [150, 135, 120].map(y => ({ x: 49, y: y - 3, w: 10, h: 13 })) });
  const result = await exportPdf(await doc.save(), model([edit]));
  expect(result.contentTextOutcomes).toMatchObject([{ mode: 'retypeset' }]);
  const written = await PDFDocument.load(result.bytes);
  const page = createSemanticInspector(written).inspectPage(0)!;
  expect(page.dependencies.map(b => [b.dependency.mcid, glyphText(b.spans[0]!.glyphs)])).toEqual([
    [0, '!!'], [1, '?'], [2, '-'],
  ]);
});

test('updates one use of a shared named property without changing its sibling', async () => {
  const input = await fixture(`/Span /Label BDC ${show('ABCDE', 150)} EMC
    /Span /Label BDC ${show('FGHIJ', 100)} EMC /P << /MCID 0 >> BDC ${show('OTHER', 40)} EMC`);
  await tag(input, [0]);
  const { doc, page } = input;
  const label = doc.context.register(doc.context.obj({ E: PDFHexString.fromText('Original label') }));
  page.node.Resources()!.set(name('Properties'), doc.context.obj({ Label: label }));
  const result = await exportPdf(await doc.save(), model([row('first', 'ABCDE', 'AXCDE', 50, 150)]));
  expect(result.semanticChanges).toMatchObject([{ overlayId: 'first', action: 'updated', dependency: { kind: 'expansion' } }]);
  expect((await inventorySemantics(result.bytes, 0)).filter(d => d.kind === 'expansion').map(d => d.text)).toEqual(['AXCDE', 'Original label']);
});

test('a shared structure label cannot be updated by replacing just one of its spans', async () => {
  const input = await fixture(`/P << /MCID 0 >> BDC ${show('ABCDE', 150)} EMC
    /P << /MCID 1 >> BDC ${show('FGHIJ', 100)} EMC ${show('KLMNO', 50)}`);
  const { doc, page } = input;
  const root = doc.context.nextRef();
  const owner = doc.context.register(doc.context.obj({
    S: 'P', P: root, Pg: page.ref, K: [0, 1], ActualText: PDFHexString.fromText('Combined label'),
  }));
  doc.context.assign(root, doc.context.obj({ Type: 'StructTreeRoot', K: owner, ParentTree: { Nums: [9, [owner, owner]] } }));
  doc.catalog.set(name('StructTreeRoot'), root);
  page.node.set(name('StructParents'), doc.context.obj(9));
  const result = await exportPdf(await doc.save(), model([
    row('partial', 'ABCDE', 'AXCDE', 50, 150), row('free', 'KLMNO', 'KLMTO', 50, 50),
  ]));
  expect(result.contentTextOutcomes).toMatchObject([{ mode: 'unsupported', reason: 'semantic-dependency' }, { mode: 'in-place' }]);
  expect(result.semanticChanges).toContainEqual(expect.objectContaining({
    overlayId: 'partial', action: 'refused', reason: 'semantic-replacement-text',
    dependency: expect.objectContaining({ text: 'Combined label' }),
  }));
  expect((await inventorySemantics(result.bytes, 0)).find(d => d.kind === 'actual-text')?.text).toBe('Combined label');
});
