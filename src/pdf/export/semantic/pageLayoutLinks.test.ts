import { expect, test } from 'bun:test';
import { PDFArray, PDFBool, PDFDict, PDFDocument, PDFName, PDFRef, PDFString } from 'pdf-lib';
import type { PageModel } from '../../model/types';
import { fixture, overlay } from '../contentText/fixtures.test-support';
import { exportPdf } from '../exportPdf';
import { createSemanticInspector } from './inspection';
import { glyphText } from './editIntent';

const name = PDFName.of;
const pages: PageModel[] = ['p', 'target', 'omitted'].map((id, sourceIndex) =>
  ({ id, sourceIndex, widthPt: 300, heightPt: 200, rotation: 0 }));
const ownerPage = pages[0]!, targetPage = pages[1]!;
const labels = { ActualText: 'ABCDE', Alt: 'Link label', E: 'Expanded label' };

async function taggedLinks({ linkOnly = false, droppedOnly = false, wrapped = false, broken = false } = {}) {
  const { doc, page } = await fixture(linkOnly ? '' :
    '/Link << /MCID 0 >> BDC BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET EMC BT /F1 10 Tf 50 50 Td (KLMNO) Tj ET');
  const ctx = doc.context;
  const target = doc.addPage([300, 200]), omitted = doc.addPage([300, 200]);
  const root = ctx.nextRef(), owner = ctx.nextRef();
  const nums = ctx.obj([]);
  const kids = ctx.obj([]);
  type Destination = [PDFRef, string] | PDFString;
  type Action = { S: string; D?: Destination; URI?: PDFString; N?: string };
  const addLink = (key: number, fields: { Dest?: Destination; A?: Action }, parent = owner) => {
    const ref = ctx.register(ctx.obj({
      Type: 'Annot', Subtype: 'Link', P: page.ref, StructParent: key,
      Rect: [50, 100, 80, 110], NM: PDFString.of(String(key)), ...fields,
    }));
    page.node.addAnnot(ref);
    nums.push(ctx.obj(key));
    nums.push(broken && key === 10 ? root : parent);
    return ctx.obj({ Type: 'OBJR', Obj: ref });
  };
  if (!linkOnly) {
    page.node.set(name('StructParents'), ctx.obj(2));
    nums.push(ctx.obj(2));
    nums.push(ctx.obj([owner]));
    kids.push(ctx.obj(0));
  }
  if (!droppedOnly) {
    kids.push(addLink(10, { A: { S: 'URI', URI: PDFString.of('https://example.org/') } }));
  }
  if (!linkOnly) {
    if (!droppedOnly) {
      kids.push(addLink(11, { Dest: [target.ref, 'Fit'] }));
      kids.push(addLink(12, { A: { S: 'GoTo', D: [page.ref, 'Fit'] } }));
      kids.push(addLink(13, { Dest: PDFString.of('retained') }));
      kids.push(addLink(14, { A: { S: 'Named', N: 'NextPage' } }));
      kids.push(addLink(15, { A: { S: 'GoTo', D: [target.ref, 'Fit'] } }));
    }
    if (wrapped) {
      const wrapper = ctx.nextRef();
      const linkOwner = ctx.nextRef();
      ctx.assign(linkOwner, ctx.obj({ S: 'Link', P: wrapper, K: [[addLink(20, { Dest: [omitted.ref, 'Fit'] }, linkOwner)]] }));
      ctx.assign(wrapper, ctx.obj({ S: 'Span', P: owner, K: [[linkOwner]] }));
      kids.push(ctx.obj([[wrapper]]));
    } else {
      kids.push(addLink(20, { Dest: [omitted.ref, 'Fit'] }));
    }
    kids.push(addLink(21, { A: { S: 'GoTo', D: PDFString.of('omitted') } }));
  }
  ctx.assign(owner, ctx.obj({
    S: 'Link', P: root, Pg: page.ref, K: linkOnly ? kids.get(0) : kids,
    ...(!linkOnly && Object.fromEntries(Object.entries(labels).map(([key, label]) => [key, PDFString.of(label)]))),
  }));
  ctx.assign(root, ctx.obj({ Type: 'StructTreeRoot', K: owner, ParentTree: { Nums: nums } }));
  doc.catalog.set(name('StructTreeRoot'), root);
  doc.catalog.set(name('MarkInfo'), ctx.obj({ Marked: true }));
  doc.catalog.set(name('Names'), ctx.obj({ Dests: {
    Names: [PDFString.of('omitted'), [omitted.ref, 'Fit'], PDFString.of('retained'), [target.ref, 'Fit']],
  } }));
  return doc.save({ useObjectStreams: false });
}

function assertLinks(doc: PDFDocument, keys: number[], index = 0) {
  const page = doc.getPage(index);
  const annots = page.node.Annots()!.asArray();
  const tree = createSemanticInspector(doc).structure;
  const objrs = tree.items.filter(item => item.type === 'object');
  expect(doc.catalog.lookup(name('MarkInfo'), PDFDict).get(name('Marked'))).toBe(PDFBool.True);
  expect(objrs.map(item => item.object)).toEqual(annots);
  expect([...tree.numberTree.values.keys()]).toEqual(tree.items.some(item => item.mcid === 0) ? [2, ...keys] : keys);
  expect(annots).toHaveLength(keys.length);
  return annots.map((ref, index) => {
    const key = keys[index]!, item = objrs[index]!;
    const annot = doc.context.lookup(ref, PDFDict);
    expect(ref).toBeInstanceOf(PDFRef);
    expect(item.object).toBe(ref);
    expect(annot.lookup(name('StructParent')).toString()).toBe(String(key));
    expect(annot.lookup(name('NM'), PDFString).decodeText()).toBe(String(key));
    expect(annot.get(name('P'))).toBe(page.ref);
    expect(item.reference?.get(name('Pg'))).toBe(page.ref);
    expect(doc.context.lookup(tree.numberTree.values.get(key))).toBe(item.owner.dict);
    return annot;
  });
}

function assertLabels(doc: PDFDocument) {
  const tree = doc.catalog.lookup(name('StructTreeRoot'), PDFDict);
  const owner = tree.lookup(name('K'), PDFDict);
  for (const [key, label] of Object.entries(labels)) expect(owner.lookup(name(key), PDFString).decodeText()).toBe(label);
}

test.each([false, true])('projects live links when the destination page is repeated: %s', async repeated => {
  const source = await taggedLinks();
  const selection = repeated ? [targetPage, ownerPage, { ...targetPage, id: 'target-copy' }] : [targetPage, ownerPage];
  const { bytes } = await exportPdf(source, { pages: selection, overlays: [] });
  const doc = await PDFDocument.load(bytes);
  const [uri, direct, self, named, other, action] = assertLinks(doc, [10, 11, 12, 13, 14, 15], 1);
  expect(uri!.lookup(name('A'), PDFDict).lookup(name('URI'), PDFString).decodeText()).toBe('https://example.org/');
  expect(direct!.lookup(name('Dest'), PDFArray).get(0)).toBe(doc.getPage(0).ref);
  expect(self!.lookup(name('A'), PDFDict).lookup(name('D'), PDFArray).get(0)).toBe(doc.getPage(1).ref);
  expect(action!.lookup(name('A'), PDFDict).lookup(name('D'), PDFArray).get(0)).toBe(doc.getPage(0).ref);
  expect(other!.lookup(name('A'), PDFDict).get(name('N'))).toBe(name('NextPage'));
  expect(named!.lookup(name('Dest'), PDFString).decodeText()).toBe('retained');
  const destinations = doc.catalog.lookup(name('Names'), PDFDict).lookup(name('Dests'), PDFDict).lookup(name('Names'), PDFArray);
  expect(destinations.size()).toBe(2);
  expect(destinations.lookup(0, PDFString).decodeText()).toBe('retained');
  expect(destinations.lookup(1, PDFArray).get(0)).toBe(doc.getPage(0).ref);
  assertLabels(doc);
});

test.each([false, true])('keeps replacement text when dropped links are the only omissions (wrapped: %s)', async wrapped => {
  const source = await taggedLinks({ droppedOnly: true, wrapped });
  const { bytes } = await exportPdf(source, { pages: [ownerPage], overlays: [] });
  const doc = await PDFDocument.load(bytes);
  const { structure } = createSemanticInspector(doc);
  expect(doc.getPage(0).node.Annots()?.size() ?? 0).toBe(0);
  expect(structure.items.map(item => item.mcid)).toEqual([0]);
  expect([...structure.numberTree.values.keys()]).toEqual([2]);
  assertLabels(doc);

  const annotated = await exportPdf(source, { pages: [ownerPage], overlays: [{
    id: 'highlight', type: 'highlight', pageId: ownerPage.id, color: '#ff0', opacity: 0.4,
    rects: [{ x: 50, y: 50, w: 30, h: 10 }],
  }] });
  const annotatedDoc = await PDFDocument.load(annotated.bytes);
  const annots = annotatedDoc.getPage(0).node.Annots()!;
  expect(annots.size()).toBe(1);
  expect(annots.lookup(0, PDFDict).get(name('Subtype'))).toBe(name('Highlight'));
  assertLabels(annotatedDoc);
});

test('a retained link alone keeps the file marked and the full no-edit export keeps its bytes', async () => {
  const source = await taggedLinks({ linkOnly: true });
  expect((await exportPdf(source, { pages, overlays: [] })).bytes).toEqual(source);
  const { bytes } = await exportPdf(source, { pages: [ownerPage], overlays: [] });
  assertLinks(await PDFDocument.load(bytes), [10]);
});

test.each([false, true])('a duplicate owning page or broken source binding cannot claim a retained link (broken: %s)', async broken => {
  const source = await taggedLinks({ linkOnly: true, broken });
  const selection = broken ? [ownerPage] : [ownerPage, { ...ownerPage, id: 'owner-copy' }];
  const { bytes } = await exportPdf(source, { pages: selection, overlays: [] });
  const doc = await PDFDocument.load(bytes);
  expect(createSemanticInspector(doc).structure.items).toEqual([]);
  for (const page of doc.getPages()) expect(page.node.Annots()!.lookup(0, PDFDict).has(name('StructParent'))).toBe(false);
});

test('refuses changing the label shared by a live link and MCID while installing independent text', async () => {
  const source = await taggedLinks();
  const rect = { x: 49, y: 48, w: 32, h: 13 };
  const independent = overlay({ id: 'independent', originalText: 'KLMNO', text: 'KLMTO', rect, coverRects: [rect] });
  const out = await exportPdf(source, { pages: [ownerPage, targetPage], overlays: [overlay(), independent] }, { acceptance: 'strict' });
  expect(out.contentTextOutcomes).toMatchObject([
    { overlayId: 'edit', mode: 'unsupported', reason: 'semantic-dependency' },
    { overlayId: independent.id, mode: 'in-place' },
  ]);
  expect(out.semanticChanges).toContainEqual(expect.objectContaining({
    overlayId: 'edit', action: 'refused', reason: 'semantic-replacement-text',
  }));
  const doc = await PDFDocument.load(out.bytes);
  expect(glyphText(createSemanticInspector(doc).inspectPage(0)!.occurrences[0]!.glyphs)).toBe('ABCDEKLMTO');
  assertLabels(doc);
  assertLinks(doc, [10, 11, 12, 13, 14, 15]);
});
