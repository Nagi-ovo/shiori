import { expect, test } from 'bun:test';
import { PDFArray, PDFBool, PDFDict, PDFDocument, PDFName, PDFNumber, PDFString } from 'pdf-lib';
import type { PageModel } from '../../model/types';
import { bytes, fixture, overlay } from '../contentText/fixtures.test-support';
import { exportPdf } from '../exportPdf';
import { inventorySemantics } from '../semanticGate';
import { glyphText } from './editIntent';
import { createSemanticInspector } from './inspection';

const name = PDFName.of;
const pages: PageModel[] = ['p', 'second'].map((id, sourceIndex) =>
  ({ id, sourceIndex, widthPt: 300, heightPt: 200, rotation: 0 }));
const first = pages[0]!, second = pages[1]!;
const labels = { ActualText: 'ABCDE', Alt: 'Accessible label', E: 'Expanded label' };
const markedText = '/P << /MCID 0 >> BDC BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET EMC';

async function taggedAnnotation(subtype: string) {
  const { doc, page } = await fixture(markedText);
  const other = doc.addPage([300, 200]);
  const ctx = doc.context;
  const rootRef = ctx.nextRef(), ownerRef = ctx.nextRef();
  const annotation = ctx.obj({
    Type: 'Annot', Subtype: subtype, P: page.ref, StructParent: 10, Rect: [50, 100, 80, 110],
  });
  if (subtype === 'Link') {
    annotation.set(name('A'), ctx.obj({ S: 'URI', URI: PDFString.of('https://example.org/') }));
  } else if (subtype === 'Highlight') {
    annotation.set(name('QuadPoints'), ctx.obj([50, 110, 80, 110, 50, 100, 80, 100]));
  } else if (subtype === 'FileAttachment') {
    const stream = ctx.register(ctx.stream(bytes('page attachment'), { Type: 'EmbeddedFile' }));
    annotation.set(name('FS'), ctx.register(ctx.obj({ Type: 'Filespec', F: PDFString.of('file.txt'), EF: { F: stream } })));
  }
  const annotationRef = ctx.register(annotation);
  page.node.addAnnot(annotationRef);
  page.node.set(name('StructParents'), ctx.obj(2));
  const objr = ctx.obj({ Type: 'OBJR', Obj: annotationRef });
  const kids = ctx.obj([0, ctx.register(objr)]);
  const owner = ctx.obj({
    Type: 'StructElem', S: subtype === 'Link' ? 'Link' : 'P', P: rootRef, Pg: page.ref, K: kids,
    ...Object.fromEntries(Object.entries(labels).map(([key, label]) => [key, PDFString.of(label)])),
  });
  ctx.assign(ownerRef, owner);
  const nums = ctx.obj([2, [ownerRef], 10, ownerRef]);
  const root = ctx.obj({ Type: 'StructTreeRoot', K: ownerRef, ParentTree: { Nums: nums } });
  ctx.assign(rootRef, root);
  doc.catalog.set(name('StructTreeRoot'), rootRef);
  doc.catalog.set(name('MarkInfo'), ctx.obj({ Marked: true }));
  return { doc, ctx, page, other, root, rootRef, nums, ownerRef, annotation, annotationRef, kids, objr };
}

function assertRemainingContent(doc: PDFDocument, role: string) {
  const rootRef = doc.catalog.get(name('StructTreeRoot'));
  const root = doc.context.lookup(rootRef, PDFDict);
  const rootKids = root.lookup(name('K'));
  if (rootKids instanceof PDFArray) expect(rootKids.size()).toBe(1);
  const ownerRef = rootKids instanceof PDFArray ? rootKids.get(0) : root.get(name('K'));
  const owner = doc.context.lookup(ownerRef, PDFDict);
  const { structure, inspectPage } = createSemanticInspector(doc);
  const page = doc.getPage(0);
  expect(doc.catalog.lookup(name('MarkInfo'), PDFDict).get(name('Marked'))).toBe(PDFBool.True);
  expect(owner.get(name('S'))).toBe(name(role));
  expect(owner.get(name('P'))).toBe(rootRef);
  expect(owner.get(name('Pg'))).toBe(page.ref);
  expect(page.node.lookup(name('StructParents'), PDFNumber).asNumber()).toBe(2);
  expect(owner.lookup(name('K'), PDFArray).asArray().map(k => k.toString())).toEqual(['0']);
  expect(structure.items.map(item => [item.type, item.mcid])).toEqual([['content', 0]]);
  expect([...structure.numberTree.values.keys()]).toEqual([2]);
  const slots = doc.context.lookup(structure.numberTree.values.get(2), PDFArray);
  expect(slots.get(0)).toBe(ownerRef);
  const marked = inspectPage(0)!.dependencies.find(binding => binding.dependency.kind === 'mcid');
  expect(marked?.owner).toBe(owner);
  const span = marked?.spans[0];
  expect(span?.issues).toEqual([]);
  expect(span?.mcid).toBe(0);
  expect(glyphText(inspectPage(0)!.occurrences[0]!.glyphs)).toBe('ABCDE');
  for (const page of doc.getPages()) expect(page.node.Annots()).toBeUndefined();
  for (const [, object] of doc.context.enumerateIndirectObjects()) if (object instanceof PDFDict) {
    expect(object.get(name('Type'))).not.toBe(name('Annot'));
    expect(object.get(name('Type'))).not.toBe(name('OBJR'));
    expect(object.has(name('StructParent'))).toBe(false);
  }
  return owner;
}

for (const subtype of ['Link', 'Highlight', 'FileAttachment']) {
  test.each([false, true])(`Original only keeps the MCID labels after removing a ${subtype} (subset: %s)`, async subset => {
    const { doc, annotation } = await taggedAnnotation(subtype);
    // /Type is optional in an annotation dictionary.
    if (subtype === 'Highlight') annotation.delete(name('Type'));
    const source = await doc.save({ useObjectStreams: false });
    const unchanged = await exportPdf(source, { pages, overlays: [] });
    expect(unchanged.bytes).toEqual(source);
    const selection = subset ? [first] : pages;
    const result = await exportPdf(source, { pages: selection, overlays: [] }, {
      mode: 'none', ...(subtype === 'FileAttachment' && { documentFiles: 'omit' }),
    });
    expect(result.bytes).not.toEqual(source);
    expect(result.acceptance).toMatchObject({ status: 'accepted', findings: [], notes: [] });
    expect(result.contentTextOutcomes).toEqual([]);
    expect(result.semanticChanges).toBeUndefined();
    const output = await PDFDocument.load(result.bytes);
    expect(output.getPageCount()).toBe(selection.length);
    const owner = assertRemainingContent(output, subtype === 'Link' ? 'Link' : 'P');
    for (const [key, label] of Object.entries(labels)) {
      expect(owner.lookup(name(key), PDFString).decodeText()).toBe(label);
    }
    const inventory = await inventorySemantics(result.bytes, 0);
    expect(inventory.map(({ kind, text }) => [kind, text])).toEqual([
      ['mcid', undefined], ['actual-text', labels.ActualText], ['alt', labels.Alt], ['expansion', labels.E],
    ]);
  });
}

type TaggedAnnotation = Awaited<ReturnType<typeof taggedAnnotation>>;
const malformed: [string, (fixture: TaggedAnnotation) => void][] = [
  ['dangling target', ({ ctx, objr }) => objr.set(name('Obj'), ctx.nextRef())],
  ['non-member', ({ ctx, annotation, objr }) => objr.set(name('Obj'), ctx.register(annotation.clone()))],
  ['non-annotation', ({ annotation }) => annotation.set(name('Type'), name('XObject'))],
  ['wrong owning page', ({ other, objr }) => objr.set(name('Pg'), other.ref)],
  ['wrong annotation page', ({ other, annotation }) => annotation.set(name('P'), other.ref)],
  ['wrong ParentTree owner', ({ nums, rootRef }) => nums.set(3, rootRef)],
  ['duplicate ParentTree key', ({ nums, ctx, ownerRef }) => {
    nums.push(ctx.obj(10));
    nums.push(ownerRef);
  }],
  ['duplicate annotation membership', ({ other, annotationRef }) => other.node.addAnnot(annotationRef)],
  ['conflicting annotation ParentTree key', ({ ctx, other, annotation }) => {
    const conflict = annotation.clone();
    conflict.set(name('P'), other.ref);
    other.node.addAnnot(ctx.register(conflict));
  }],
  ['duplicate OBJR', ({ kids }) => kids.push(kids.get(1)!)],
  ['conflicting OBJR on another page', ({ ctx, root, rootRef, ownerRef, other, annotationRef }) => {
    const objr = ctx.obj({ Type: 'OBJR', Obj: annotationRef });
    const conflict = ctx.register(ctx.obj({ Type: 'StructElem', S: 'P', P: rootRef, Pg: other.ref, K: objr }));
    root.set(name('K'), ctx.obj([ownerRef, conflict]));
  }],
];

test.each(malformed)('Original only excludes labels across an unresolved OBJR (%s)', async (_, breakBinding) => {
  const input = await taggedAnnotation('Highlight');
  breakBinding(input);
  const source = await input.doc.save();
  const { bytes } = await exportPdf(source, { pages: [first], overlays: [] }, { mode: 'none' });
  const owner = assertRemainingContent(await PDFDocument.load(bytes), 'P');
  for (const key of Object.keys(labels)) expect(owner.has(name(key))).toBe(false);
});

test.each(['content', 'annotation', 'repeated annotation page'])('Original only excludes labels spanning an omitted child (%s)', async child => {
  const { doc, ctx, page, other, objr, annotation, annotationRef, ownerRef, nums, kids } = await taggedAnnotation('Link');
  if (child === 'content') {
    other.node.set(name('Resources'), page.node.get(name('Resources'))!);
    other.node.set(name('Contents'), ctx.register(ctx.stream(bytes(markedText))));
    other.node.set(name('StructParents'), ctx.obj(3));
    kids.push(ctx.obj({ Type: 'MCR', Pg: other.ref, MCID: 0 }));
    nums.insert(2, ctx.obj(3));
    nums.insert(3, ctx.obj([ownerRef]));
  } else {
    page.node.delete(name('Annots'));
    other.node.addAnnot(annotationRef);
    annotation.set(name('P'), other.ref);
    objr.set(name('Pg'), other.ref);
  }
  const selection = child === 'repeated annotation page' ? [first, second, { ...second, id: 'second-copy' }] : [first];
  const source = await doc.save();
  const { bytes: output } = await exportPdf(source, { pages: selection, overlays: [] }, { mode: 'none' });
  const owner = assertRemainingContent(await PDFDocument.load(output), 'Link');
  for (const key of Object.keys(labels)) expect(owner.has(name(key))).toBe(false);
});

test('Original only without source annotations returns the full source bytes and ignores overlays', async () => {
  const { doc } = await fixture();
  const source = await doc.save();
  const result = await exportPdf(source, { pages: [first], overlays: [overlay()] }, { mode: 'none' });
  expect(result.bytes).toEqual(source);
  expect(result.acceptance).toMatchObject({ status: 'accepted', findings: [] });
});
