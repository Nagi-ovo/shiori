import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PDFArray, PDFBool, PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { buildFlow, linkedFlowStory } from '../contentText/flow/linkedFlow.test-support';
import { planLinkedFlow } from '../contentText/flow/flowPlan';
import { fixture, overlay } from '../contentText/fixtures.test-support';
import { exportPdf } from '../exportPdf';
import { inventorySemantics } from '../semanticGate';
import { listSourceImages } from '../sourceImages';
import { createSemanticInspector } from './inspection';
import { glyphText } from './editIntent';

const name = PDFName.of;
const page = { id: 'p', sourceIndex: 1, widthPt: 300, heightPt: 200, rotation: 0 } as const;
const other = { ...page, id: 'other', sourceIndex: 0 };
const blank = { ...page, id: 'blank', sourceIndex: -1, blank: true } as const;
const show = (text: string, y: number) => `BT /F1 10 Tf 50 ${y} Td (${text}) Tj ET`;

async function taggedPages(options?: { label?: 'leaf' | 'group'; explicit?: boolean; broken?: boolean }) {
  const { doc, page: earlier } = await fixture(`/P << /MCID 0 >> BDC ${show('REMOVED', 100)} EMC`);
  const ctx = doc.context;
  const later = doc.addPage([300, 200]);
  later.node.set(name('Resources'), earlier.node.Resources()!.clone());
  const part = ctx.register(ctx.stream(`/P << /MCID 0 >> BDC ${show('ABCDE', 100)} EMC ${show('KLMNO', 50)}`));
  later.node.set(name('Contents'), part);
  earlier.node.set(name('StructParents'), ctx.obj(2));
  later.node.set(name('StructParents'), ctx.obj(3));
  const tree = ctx.nextRef(), section = ctx.nextRef();
  const removed = ctx.register(ctx.obj({ S: 'P', P: section, Pg: earlier.ref, K: 0, Alt: PDFString.of('Removed label') }));
  const kept = ctx.register(ctx.obj({
    S: 'P', P: section, Pg: later.ref,
    K: options?.explicit ? { Type: 'MCR', MCID: 0, Stm: part, StmOwn: later.ref } : 0,
    ...(options?.label === 'leaf' && { ActualText: PDFString.of('ABCDE') }),
  }));
  ctx.assign(section, ctx.obj({
    S: 'Sect', P: tree, K: [removed, kept],
    ...(options?.label === 'group' && { ActualText: PDFString.of('REMOVED ABCDE') }),
  }));
  ctx.assign(tree, ctx.obj({ Type: 'StructTreeRoot', K: section,
    ParentTree: { Kids: [{ Nums: [2, [removed], 3, [options?.broken ? null : kept]] }] },
    IDTree: { Names: [PDFString.of('Removed identifier'), removed] },
    ClassMap: { RemovedClass: { O: 'Layout', Title: PDFString.of('Removed class label') } },
  }));
  doc.catalog.set(name('StructTreeRoot'), tree);
  doc.catalog.set(name('MarkInfo'), ctx.obj({ Marked: true }));
  return doc.save({ useObjectStreams: false });
}

const marked = overlay({ id: 'marked' });
const freeRect = { x: 49, y: 48, w: 32, h: 13 };
const free = overlay({ id: 'free', originalText: 'KLMNO', text: 'KLMTO', rect: freeRect, coverRects: [freeRect] });

async function assertRetainedPage(bytes: Uint8Array, index: number, text: string) {
  const doc = await PDFDocument.load(bytes);
  const tree = doc.catalog.lookup(name('StructTreeRoot'), PDFDict);
  expect(doc.catalog.lookup(name('MarkInfo'), PDFDict).get(name('Marked'))).toBe(PDFBool.True);
  const inspection = createSemanticInspector(doc);
  const content = inspection.inspectPage(index)!;
  expect(content.issues.filter(issue => issue.kind !== 'coverage')).toEqual([]);
  expect(glyphText(content.occurrences[0]!.glyphs)).toBe(text);
  const owner = inspection.structure.items.find(item => item.page === doc.getPage(index).ref && item.mcid === 0)!.owner;
  expect(owner.parent?.dict.get(name('P'))).toBe(doc.catalog.get(name('StructTreeRoot')));
  expect(inspection.structure.numberTree.values.has(3)).toBe(true);
  expect(doc.context.lookup(inspection.structure.numberTree.values.get(3), PDFArray).lookup(0)).toBe(owner.dict);
  if (doc.getPageCount() === 1) {
    expect(inspection.structure.numberTree.values.has(2)).toBe(false);
    expect(tree.has(name('IDTree'))).toBe(false);
    expect(tree.has(name('ClassMap'))).toBe(false);
    expect(new TextDecoder().decode(bytes)).not.toMatch(/REMOVED|Removed label|Removed identifier|Removed class label/);
    expect(inspection.structure.items).toHaveLength(1);
    expect(doc.context.enumerateIndirectObjects().filter(([, object]) =>
      object instanceof PDFDict && object.get(name('Type')) === name('Page'))).toHaveLength(1);
  }
}

test.each([
  ['blank append', [other, page, blank], 1, 0],
  ['drop another page', [page], 0, undefined],
  ['rotate another page', [{ ...other, rotation: 90 as const }, page], 1, 90],
  ['reorder pages', [page, other], 0, 0],
] as const)('installs independent and whole-MCID edits after %s', async (_layout, pages, index, rotation) => {
  const source = await taggedPages();
  for (const acceptance of ['review', 'strict'] as const) {
    for (const edits of [[free], [marked], [free, marked]]) {
      const out = await exportPdf(source, { pages: [...pages], overlays: edits }, { acceptance });
      expect(out.acceptance.status).toBe('accepted');
      expect(out.contentTextOutcomes).toEqual(edits.map(({ id }) => expect.objectContaining({
        overlayId: id, mode: 'in-place', pageIndex: index,
      })));
      expect(out.semanticChanges ?? []).toEqual(edits.includes(marked) ? [expect.objectContaining({
        overlayId: marked.id, action: 'preserved', dependency: expect.objectContaining({ pageIndex: 1, mcid: 0 }),
      })] : []);
      const doc = await PDFDocument.load(out.bytes);
      expect(doc.getPageCount()).toBe(pages.length);
      if (rotation !== undefined) expect(doc.getPage(1 - index).getRotation().angle).toBe(rotation);
      await assertRetainedPage(out.bytes, index, (edits.includes(marked) ? 'AXCDE' : 'ABCDE') + (edits.includes(free) ? 'KLMTO' : 'KLMNO'));
    }
  }
  const layoutOnly = await exportPdf(source, { pages: [...pages], overlays: [] });
  await assertRetainedPage(layoutOnly.bytes, index, 'ABCDEKLMNO');
});

test('retains a subset label and refuses a partial edit while writing independent text', async () => {
  const source = await taggedPages({ label: 'leaf' });
  const cut = { x: 56, y: 98, w: 6, h: 13 };
  const partial = overlay({ id: 'partial', originalText: 'B', text: 'X', rect: cut, coverRects: [cut] });
  const out = await exportPdf(source, { pages: [page], overlays: [partial, free] }, { acceptance: 'strict' });
  expect(out.contentTextOutcomes).toMatchObject([
    { overlayId: partial.id, mode: 'unsupported', reason: 'semantic-dependency' },
    { overlayId: free.id, mode: 'in-place' },
  ]);
  expect(out.semanticChanges).toContainEqual(expect.objectContaining({
    overlayId: partial.id, action: 'refused', reason: 'semantic-replacement-text',
    dependency: expect.objectContaining({ pageIndex: 1, kind: 'actual-text' }),
  }));
  expect(await inventorySemantics(out.bytes, 0)).toContainEqual(expect.objectContaining({ text: 'ABCDE', source: 'struct-elem' }));
  await assertRetainedPage(out.bytes, 0, 'ABCDEKLMTO');

  const updated = await exportPdf(source, { pages: [page], overlays: [marked] }, { acceptance: 'strict' });
  expect(updated.acceptance.status).toBe('accepted');
  expect(await inventorySemantics(updated.bytes, 0)).toContainEqual(expect.objectContaining({ text: 'AXCDE', source: 'struct-elem' }));
  expect(updated.semanticChanges).toContainEqual(expect.objectContaining({ action: 'updated' }));
});

test('omits a cross-page label with its removed child and refuses edits covered by the source label', async () => {
  const out = await exportPdf(await taggedPages({ label: 'group' }), { pages: [page], overlays: [marked, free] });
  expect(out.contentTextOutcomes).toMatchObject([{ mode: 'unsupported' }, { mode: 'in-place' }]);
  expect(out.semanticChanges).toContainEqual(expect.objectContaining({
    overlayId: marked.id, action: 'refused', reason: 'semantic-replacement-text',
  }));
  expect(await inventorySemantics(out.bytes, 0)).toMatchObject([{ kind: 'mcid' }]);
  await assertRetainedPage(out.bytes, 0, 'ABCDEKLMTO');
});

test('keeps an explicit MCR live on layout-only export and retries around a stream rewrite', async () => {
  const source = await taggedPages({ explicit: true });
  const out = await exportPdf(source, { pages: [page, blank], overlays: [marked] });
  expect(out.contentTextOutcomes).toMatchObject([{ mode: 'unsupported', reason: 'semantic-dependency' }]);
  expect(out.semanticChanges).toContainEqual(expect.objectContaining({
    action: 'refused', dependency: expect.objectContaining({ pageIndex: 1, kind: 'mcr-stm' }),
  }));
  const doc = await PDFDocument.load(out.bytes);
  expect(doc.getPageCount()).toBe(2);
  const { items } = createSemanticInspector(doc).structure;
  expect(items[0]?.stream).toBe(doc.getPage(0).node.get(name('Contents')));
  expect(items[0]?.streamOwner).toBe(doc.getPage(0).ref);
  expect(await inventorySemantics(out.bytes, 0)).toContainEqual(expect.objectContaining({ kind: 'mcr-stm' }));
});

test('does not use a deleted page or a duplicated occurrence to repair source ownership', async () => {
  const copy = { ...page, id: 'copy' };
  for (const broken of [false, true]) {
    const source = await taggedPages({ broken });
    const out = await exportPdf(source, { pages: broken ? [page] : [page, copy], overlays: [marked, free] });
    expect(out.contentTextOutcomes).toMatchObject([{ mode: 'unsupported' }, { mode: 'in-place' }]);
    expect(out.semanticChanges?.map(row => [row.overlayId, row.action, row.reason])).toEqual([
      [marked.id, 'refused', broken ? 'semantic-unresolved' : 'semantic-structure-reference'],
    ]);
    const doc = await PDFDocument.load(out.bytes);
    const inspection = createSemanticInspector(doc);
    expect(glyphText(inspection.inspectPage(0)!.occurrences[0]!.glyphs)).toBe('ABCDEKLMTO');
    if (!broken) expect(glyphText(inspection.inspectPage(1)!.occurrences[0]!.glyphs)).toBe('ABCDEKLMNO');
    expect(inspection.structure.items).toEqual([]);
    for (const page of doc.getPages()) expect(page.node.has(name('StructParents'))).toBe(false);
  }
});

test('projects a live OBJR and removes an OBJR whose navigation target was dropped', async () => {
  const { doc, page: dropped } = await fixture();
  const kept = doc.addPage([300, 200]), ctx = doc.context;
  const root = ctx.nextRef();
  const owners = [ctx.nextRef(), ctx.nextRef()];
  const highlight = ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'Highlight', StructParent: 10, P: kept.ref,
    Rect: [40, 40, 70, 50], QuadPoints: [40, 50, 70, 50, 40, 40, 70, 40],
  }));
  const link = ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'Link', StructParent: 11, P: kept.ref,
    Rect: [40, 80, 70, 90], Dest: [dropped.ref, 'Fit'],
  }));
  kept.node.addAnnot(highlight);
  kept.node.addAnnot(link);
  for (const [index, obj] of [highlight, link].entries()) {
    ctx.assign(owners[index]!, ctx.obj({ S: 'Annot', P: root, Pg: kept.ref, K: { Type: 'OBJR', Obj: obj } }));
  }
  ctx.assign(root, ctx.obj({ K: owners, ParentTree: { Nums: [10, owners[0]!, 11, owners[1]!] } }));
  doc.catalog.set(name('StructTreeRoot'), root);
  const out = await exportPdf(await doc.save(), { pages: [page], overlays: [] });
  const saved = await PDFDocument.load(out.bytes);
  const { structure } = createSemanticInspector(saved);
  expect(structure.items).toHaveLength(1);
  expect(structure.items[0]?.page).toBe(saved.getPage(0).ref);
  expect(saved.getPage(0).node.Annots()!.asArray()).toEqual([structure.items[0]?.object]);
  expect(structure.numberTree.values.has(11)).toBe(false);
  expect(await inventorySemantics(out.bytes, 0)).toMatchObject([{ kind: 'objr' }]);
});

test('a moved marked image keeps its owner and reports the source page', async () => {
  const { doc } = await fixture();
  const imgPage = doc.addPage([300, 200]), ctx = doc.context;
  const root = ctx.nextRef();
  const image = ctx.register(ctx.stream(Uint8Array.of(100), {
    Subtype: 'Image', Width: 1, Height: 1, ColorSpace: 'DeviceGray', BitsPerComponent: 8,
  }));
  imgPage.node.set(name('Contents'), ctx.register(ctx.stream('/Figure << /MCID 0 >> BDC q 20 0 0 20 30 40 cm /Im Do Q EMC')));
  imgPage.node.set(name('Resources'), ctx.obj({ XObject: { Im: image } }));
  imgPage.node.set(name('StructParents'), ctx.obj(3));
  const owner = ctx.register(ctx.obj({ S: 'Figure', P: root, Pg: imgPage.ref, K: 0 }));
  ctx.assign(root, ctx.obj({ K: owner, ParentTree: { Nums: [3, [owner]] } }));
  doc.catalog.set(name('StructTreeRoot'), root);
  const source = await doc.save();
  const [target] = await listSourceImages(source, 1);
  const out = await exportPdf(source, { pages: [page, blank], overlays: [{
    id: 'move', pageId: page.id, type: 'sourceImageEdit', target: target!, rect: { x: 90, y: 40, w: 20, h: 20 },
  }] });
  expect(out.sourceImageOutcomes).toMatchObject([{ mode: 'applied' }]);
  expect(out.semanticChanges).toMatchObject([{ action: 'preserved', dependency: { pageIndex: 1, kind: 'mcid' } }]);
  expect(await inventorySemantics(out.bytes, 0)).toMatchObject([{ structElem: expect.any(String), bbox: { x: 90 } }]);
});

test('the marked linked-flow plan and export agree after page insertion and reindexing', async () => {
  const flow = await buildFlow({ ...linkedFlowStory, spans: 'mcid' }, path => readFileSync(path));
  const doc = await PDFDocument.load(flow.bytes);
  const ctx = doc.context, sourcePage = doc.getPage(0), root = ctx.nextRef();
  const owner = ctx.register(ctx.obj({ S: 'P', P: root, Pg: sourcePage.ref, K: 7 }));
  sourcePage.node.set(name('StructParents'), ctx.obj(4));
  ctx.assign(root, ctx.obj({ K: owner, ParentTree: { Nums: [4, [...Array(7).fill(null), owner]] } }));
  doc.catalog.set(name('StructTreeRoot'), root);
  doc.insertPage(0, [300, 200]);
  const source = await doc.save();
  const model = { ...flow.model, pages: [{ ...flow.model.pages[0]!, sourceIndex: 1 }, blank] };
  const plan = await planLinkedFlow(source, model, 'chain-1');
  const out = await exportPdf(source, model, { acceptance: 'strict' });
  expect(plan).toMatchObject({ ok: true, semanticChanges: [
    { action: 'preserved', dependency: { pageIndex: 1, kind: 'mcid', mcid: 7 } },
  ] });
  expect(out.contentTextOutcomes).toMatchObject([{ mode: 'retypeset', pageIndex: 0 }]);
  expect(out.semanticChanges).toEqual(plan.semanticChanges);
  expect(await inventorySemantics(out.bytes, 0)).toMatchObject([{ mcid: 7, structElem: expect.any(String) }]);

  const duplicate = { ...model, pages: [model.pages[0]!, { ...model.pages[0]!, id: 'repeat' }] };
  const denied = await planLinkedFlow(source, duplicate, 'chain-1');
  const unedited = await exportPdf(source, duplicate);
  expect(denied).toMatchObject({ ok: false, reason: 'semantic-dependency' });
  expect(unedited.contentTextOutcomes).toMatchObject([{ mode: 'unsupported', reason: 'semantic-dependency' }]);
  expect(unedited.semanticChanges).toEqual(denied.semanticChanges);
  expect(unedited.semanticChanges).toMatchObject([{ action: 'refused', dependency: { pageIndex: 1, mcid: 7 } }]);
}, 15_000);
