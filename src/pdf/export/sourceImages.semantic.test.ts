import { expect, test } from 'bun:test';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFString } from 'pdf-lib';
import { buildContentTextPreview } from '../../editor/components/contentTextPreview';
import type { PageModel, SourceImageEditOverlay } from '../model/types';
import { fixture, overlay as textOverlay } from './contentText/fixtures.test-support';
import { exportPdf } from './exportPdf';
import { inventorySemantics } from './semanticGate';
import { listSourceImages, type SourceImageAddress } from './sourceImages';

const name = PDFName.of;
const page: PageModel = { id: 'p', sourceIndex: 0, rotation: 0, widthPt: 300, heightPt: 200 };
const edit = (target: SourceImageAddress, patch: Partial<SourceImageEditOverlay> = {}): SourceImageEditOverlay =>
  ({ id: 'tagged', pageId: page.id, type: 'sourceImageEdit', target, ...patch });

async function taggedImage(layout: 'page' | 'objr' | 'owner' | 'explicit' | 'missing-property' | 'bad-parent' | 'alt' | 'plain-form') {
  const doc = await PDFDocument.create();
  const p = doc.addPage([page.widthPt, page.heightPt]);
  const c = doc.context;
  const tagged = c.register(c.stream(Uint8Array.of(0, 100, 24), {
    Type: 'XObject', Subtype: 'Image', Width: 1, Height: 1, ColorSpace: 'DeviceRGB', BitsPerComponent: 8,
    ...(layout === 'objr' && { StructParent: 9 }),
  }));
  const other = c.register(c.stream(Uint8Array.of(17, 5, 17), {
    Type: 'XObject', Subtype: 'Image', Width: 1, Height: 1, ColorSpace: 'DeviceRGB', BitsPerComponent: 8,
  }));
  const tree = c.nextRef();
  const draw = (image: string) => `q 20 0 0 20 30 40 cm /${image} Do Q`;
  const marked = layout === 'alt'
    ? `/Figure /Description BDC ${draw('Tagged')} EMC`
    : `/Figure << /MCID 0 >> BDC ${layout === 'plain-form' ? '/Picture Do' : draw('Tagged')} EMC`;
  const local = layout === 'owner' ? '/Outer Do' : layout === 'objr' ? draw('Tagged')
    : layout === 'missing-property' ? `/Figure /Missing BDC ${draw('Tagged')} EMC` : marked;
  const part = c.register(c.stream(local));
  p.node.set(name('Contents'), c.obj([part, c.register(c.stream(draw('Other')))]));
  const refs: Record<string, typeof tagged> = { Tagged: tagged, Other: other };
  if (layout === 'plain-form') refs.Picture = c.register(c.stream(draw('Tagged'), {
    Subtype: 'Form', BBox: [0, 0, 200, 200], Resources: { XObject: { Tagged: tagged } },
  }));
  const owner = c.nextRef();
  if (layout === 'owner') {
    const inner = c.register(c.stream('/Span << /MCID 0 >> BDC 0 0 1 1 re f EMC', {
      Subtype: 'Form', BBox: [0, 0, 80, 80], StructParents: 9,
    }));
    refs.Outer = c.register(c.stream(`${draw('Tagged')} /Inner Do`, {
      Subtype: 'Form', BBox: [0, 0, 80, 80], Resources: { XObject: { Inner: inner, Tagged: tagged } },
    }));
    c.assign(owner, c.obj({ P: tree, Pg: p.ref, S: 'Figure',
      K: { Type: 'MCR', Stm: inner, StmOwn: refs.Outer, MCID: 0 } }));
  } else {
    c.assign(owner, c.obj({ P: tree, Pg: p.ref, S: 'Figure',
      K: layout === 'objr' ? { Type: 'OBJR', Obj: tagged } :
        layout === 'explicit' ? { Type: 'MCR', Stm: part, StmOwn: p.ref, MCID: 0 } : 0,
    }));
  }
  c.assign(tree, c.obj({ Type: 'StructTreeRoot', K: owner,
    ParentTree: { Nums: layout === 'missing-property' || layout === 'bad-parent' ? [] :
      [9, layout === 'objr' ? owner : [owner]] } }));
  if (layout !== 'objr' && layout !== 'owner') p.node.set(name('StructParents'), c.obj(9));
  doc.catalog.set(name('StructTreeRoot'), tree);
  p.node.set(name('Resources'), c.obj({ XObject: refs,
    ...(layout === 'alt' && { Properties: { Description: { MCID: 0, Alt: PDFString.of('Original artwork') } } }),
  }));
  const bytes = await doc.save();
  const [first, second] = await listSourceImages(bytes, 0);
  return { bytes, first: first!, second: second! };
}

// A selected paint can lose its owner, leave a dangling object reference, or
// share its rectangle with an unrelated paint. Preview must use the same verdict.
test('keeps a moved MCID image in its span and removes an independent overlapping image', async () => {
  const { bytes, first, second } = await taggedImage('page');
  expect(first.bbox).toEqual(second.bbox);
  const overlays = [edit(first, { rect: { x: 80, y: 40, w: 20, h: 20 } }), edit(second, { id: 'other', delete: true })];
  const result = await exportPdf(bytes, { pages: [page], overlays });
  expect(result.acceptance.status).toBe('accepted');
  expect(result.sourceImageOutcomes?.map(row => row.mode)).toEqual(['applied', 'applied']);
  expect(result.semanticChanges).toMatchObject([{ overlayId: 'tagged', action: 'preserved', dependency: { kind: 'mcid', mcid: 0 } }]);
  expect(await inventorySemantics(result.bytes, 0)).toMatchObject([{ kind: 'mcid', mcid: 0, bbox: { x: 80 } }]);
  const out = await PDFDocument.load(result.bytes);
  const tree = out.catalog.lookup(name('StructTreeRoot'), PDFDict);
  const parents = tree.lookup(name('ParentTree'), PDFDict).lookup(name('Nums'), PDFArray);
  expect(parents.lookup(1, PDFArray).get(0)).toBe(tree.get(name('K')));
  const preview = await buildContentTextPreview(bytes, page, overlays);
  expect(preview.imageOutcomes).toEqual(result.sourceImageOutcomes);
  expect(preview.semanticChanges).toEqual(result.semanticChanges);
  expect(await listSourceImages(preview.bytes!, 0)).toEqual(await listSourceImages(result.bytes, 0));
});

test.each([
  ['page', 'mcid', 'semantic-structure-reference'],
  ['objr', 'objr', 'semantic-structure-reference'],
  ['owner', 'mcr-stm', 'semantic-structure-reference'],
  ['explicit', 'mcr-stm', 'semantic-structure-reference'],
  ['bad-parent', 'mcid', 'semantic-unresolved'],
  ['missing-property', 'mcid', 'semantic-unresolved'],
] as const)('refuses the %s image without suppressing another edit', async (layout, kind, reason) => {
  const { bytes, first, second } = await taggedImage(layout);
  const tagged = edit(first, { delete: true });
  const sourceOnly = await exportPdf(bytes, { pages: [page], overlays: [tagged] });
  expect(sourceOnly.bytes).toEqual(bytes);
  const overlays = [tagged, edit(second, { id: 'other', delete: true })];
  const result = await exportPdf(bytes, { pages: [page], overlays }, { acceptance: 'strict' });
  expect(result.acceptance).toMatchObject({ status: 'refused', findings: [{ kind: 'unexcised-edit', count: 1 }] });
  expect(result.sourceImageOutcomes).toMatchObject([
    { overlayId: 'tagged', mode: 'unsupported', reason: 'unsupported-context' },
    { overlayId: 'other', mode: 'applied' },
  ]);
  expect(result.semanticChanges).toContainEqual(expect.objectContaining({
    overlayId: 'tagged', action: 'refused', reason, dependency: expect.objectContaining({ kind }),
  }));
  const [remaining, removed] = await listSourceImages(result.bytes, 0);
  expect(remaining?.fingerprint).toBe(first.fingerprint);
  expect(removed).toBeUndefined();
  const source = await PDFDocument.load(bytes);
  const output = await PDFDocument.load(result.bytes);
  const firstPart = (doc: PDFDocument) =>
    doc.getPage(0).node.lookup(name('Contents'), PDFArray).lookup(0, PDFRawStream).getContents();
  expect(firstPart(output)).toEqual(firstPart(source));
});

test.each(['objr', 'plain-form'] as const)('moves an image with valid %s ownership', async layout => {
  const { bytes, first, second } = await taggedImage(layout);
  const result = await exportPdf(bytes, { pages: [page], overlays: [
    edit(first, { rect: { x: 90, y: 40, w: 20, h: 20 } }),
  ] });
  expect(result.acceptance.status).toBe('accepted');
  expect(result.semanticChanges).toMatchObject([{
    overlayId: 'tagged', action: 'preserved', dependency: { kind: layout === 'objr' ? 'objr' : 'mcid' },
  }]);
  const [moved, untouched] = await listSourceImages(result.bytes, 0);
  expect(moved).toMatchObject({ fingerprint: first.fingerprint, bbox: { x: 90 } });
  expect(untouched).toMatchObject({ fingerprint: second.fingerprint, bbox: second.bbox });
  if (layout === 'objr') {
    const out = await PDFDocument.load(result.bytes);
    const root = out.catalog.lookup(name('StructTreeRoot'), PDFDict);
    const objr = root.lookup(name('K'), PDFDict).lookup(name('K'), PDFDict);
    const objects = out.getPage(0).node.Resources()!.lookup(name('XObject'), PDFDict);
    expect(objr.get(name('Obj'))).toBe(objects.get(name('Tagged')));
  }
});

test('keeps a named image description during a move and refuses to leave it on a replacement', async () => {
  const { bytes, first } = await taggedImage('alt');
  const moved = await exportPdf(bytes, { pages: [page], overlays: [
    edit(first, { rect: { x: 80, y: 40, w: 20, h: 20 } }),
  ] });
  expect(moved.semanticChanges).toContainEqual(expect.objectContaining({
    action: 'preserved', dependency: expect.objectContaining({ kind: 'alt', source: 'properties', text: 'Original artwork' }),
  }));
  const replace = {
    mimeType: 'image/png' as const,
    dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  };
  const replacement = await buildContentTextPreview(bytes, page, [edit(first, { replace })]);
  expect(replacement.imageOutcomes).toMatchObject([{ mode: 'unsupported', reason: 'unsupported-context' }]);
  expect(replacement.semanticChanges).toContainEqual(expect.objectContaining({
    action: 'refused', reason: 'semantic-replacement-text', dependency: expect.objectContaining({ kind: 'alt' }),
  }));
  expect(replacement.bytes).toBeNull();
});

test('retains an annotation OBJR when its appearance image refuses and an independent image is deleted', async () => {
  const doc = await PDFDocument.create();
  const p = doc.addPage([300, 200]);
  const witness = doc.addPage([300, 200]);
  const ctx = doc.context;
  const sample = (pixel: number) => ctx.register(ctx.stream(Uint8Array.of(pixel), {
    Subtype: 'Image', Width: 1, Height: 1, ColorSpace: 'DeviceGray', BitsPerComponent: 8,
  }));
  const inner = sample(210);
  const appearance = ctx.register(ctx.stream('/Inner Do', {
    Subtype: 'Form', BBox: [0, 0, 20, 20], Resources: { XObject: { Inner: inner } },
  }));
  const annotation = ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'Highlight', P: p.ref, StructParent: 17,
    Rect: [20, 20, 40, 40], QuadPoints: [20, 40, 40, 40, 20, 20, 40, 20], AP: { N: appearance },
  }));
  p.node.addAnnot(annotation);
  p.node.set(name('Resources'), ctx.obj({ XObject: { Plain: sample(150) } }));
  p.node.set(name('Contents'), ctx.register(ctx.stream('/Plain Do')));
  witness.node.set(name('Resources'), ctx.obj({ XObject: { Inner: inner } }));
  witness.node.set(name('Contents'), ctx.register(ctx.stream('/Inner Do')));
  const root = ctx.nextRef();
  const elem = ctx.register(ctx.obj({ P: root, Pg: p.ref, S: 'Figure', K: { Type: 'OBJR', Obj: annotation } }));
  ctx.assign(root, ctx.obj({ Type: 'StructTreeRoot', K: elem, ParentTree: { Nums: [17, elem] } }));
  doc.catalog.set(name('StructTreeRoot'), root);
  const bytes = await doc.save();
  const [ordinary] = await listSourceImages(bytes, 0);
  const [inAppearance] = await listSourceImages(bytes, 1);
  const overlays = [edit({ ...inAppearance!, pageIndex: 0 }, { delete: true }), edit(ordinary!, { id: 'plain', delete: true })];
  const result = await exportPdf(bytes, { pages: [page, { ...page, id: 'other', sourceIndex: 1 }], overlays });
  expect(result.sourceImageOutcomes).toMatchObject([
    { mode: 'unsupported', reason: 'unsupported-context' }, { mode: 'applied' },
  ]);
  expect(result.semanticChanges).toMatchObject([{ action: 'refused', dependency: { kind: 'objr', pageIndex: 0 } }]);
  const out = await PDFDocument.load(result.bytes);
  const objr = out.catalog.lookup(name('StructTreeRoot'), PDFDict).lookup(name('K'), PDFDict).lookup(name('K'), PDFDict);
  expect(objr.get(name('Obj'))).toBe(out.getPage(0).node.Annots()!.get(0));
  expect(await listSourceImages(result.bytes, 0)).toEqual([]);
});

test('strict text rollback preserves an independent image write and review reports legacy stripping', async () => {
  const { doc, page: source } = await fixture(
    '/Span <</ActualText (Expanded label) /MCID 4>> BDC BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET EMC ' +
    'q 20 0 0 20 30 25 cm /Image Do Q',
  );
  source.node.Resources()!.set(name('XObject'), doc.context.obj({
    Image: doc.context.register(doc.context.stream(Uint8Array.of(73), {
      Subtype: 'Image', Width: 1, Height: 1, ColorSpace: 'DeviceGray', BitsPerComponent: 8,
    })),
  }));
  const bytes = await doc.save();
  const [image] = await listSourceImages(bytes, 0);
  const overlays = [textOverlay({ id: 'text', pageId: page.id, text: 'AXCDE' }), edit(image!, { delete: true })];
  const model = { pages: [page], overlays };
  const review = await exportPdf(bytes, model);
  expect(review.semanticChanges).toContainEqual(expect.objectContaining({ overlayId: 'text', action: 'stripped' }));
  expect(review.sourceImageOutcomes).toMatchObject([{ mode: 'applied' }]);
  const strict = await exportPdf(bytes, model, { acceptance: 'strict' });
  expect(strict.contentTextOutcomes).toMatchObject([{ reason: 'acceptance-strict' }]);
  expect(strict.sourceImageOutcomes).toMatchObject([{ mode: 'applied' }]);
  expect(strict.acceptance.findings).toContainEqual({ kind: 'stripped-equivalent', overlayId: 'text', pageIndex: 0 });
  expect(await listSourceImages(strict.bytes, 0)).toEqual([]);
  expect(await inventorySemantics(strict.bytes, 0)).toContainEqual(expect.objectContaining({ text: 'Expanded label' }));
});
