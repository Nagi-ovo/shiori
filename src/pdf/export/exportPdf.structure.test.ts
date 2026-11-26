import { expect, test } from 'bun:test';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef } from 'pdf-lib';
import type { DocumentModel } from '../model/types';
import { exportPdf } from './exportPdf';

const name = PDFName.of;

test.each([false, true])('keeps Form MCR, StmOwn and annotation OBJR after copying (subset: %s)', async subset => {
  const source = await PDFDocument.create();
  const page = source.addPage([300, 400]);
  const ctx = source.context;
  const form = ctx.register(ctx.stream('/Span << /MCID 0 >> BDC 0 0 40 40 re f EMC', {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 40, 40], StructParents: 14,
  }));
  const parentForm = ctx.register(ctx.stream('/F Do', {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 40, 40], Resources: { XObject: { F: form } },
  }));
  page.node.Resources()!.set(name('XObject'), ctx.obj({ Outer: parentForm }));
  page.node.set(name('Contents'), ctx.register(ctx.stream('/Outer Do')));
  const annotation = ctx.register(ctx.obj({
    Type: 'Annot', Rect: [100, 140, 140, 150], StructParent: 15, P: page.ref,
    ...(subset ? { Subtype: 'Highlight', QuadPoints: [100, 150, 140, 150, 100, 140, 140, 140] }
      : { Subtype: 'Link', Dest: [page.ref, 'Fit'] }),
  }));
  page.node.addAnnot(annotation);
  const tree = ctx.nextRef();
  const formOwner = ctx.register(ctx.obj({ S: 'Span', P: tree, Pg: page.ref,
    K: { Type: 'MCR', Stm: form, StmOwn: parentForm, MCID: 0 } }));
  const linkOwner = ctx.register(ctx.obj({ S: 'Link', P: tree, Pg: page.ref, K: { Type: 'OBJR', Obj: annotation } }));
  ctx.assign(tree, ctx.obj({ Type: 'StructTreeRoot', K: [formOwner, linkOwner], ParentTree: { Nums: [14, [formOwner], 15, linkOwner] } }));
  source.catalog.set(name('StructTreeRoot'), tree);
  if (subset) source.addPage([300, 400]);
  const bytes = await source.save();
  const model: DocumentModel = {
    pages: [{ id: 'page', sourceIndex: 0, rotation: 0, widthPt: 300, heightPt: 400 }],
    overlays: [],
  };
  if (!subset) expect((await exportPdf(bytes, model)).bytes).toEqual(bytes);
  const result = await exportPdf(bytes, { ...model, overlays: [{
    id: 'new', pageId: 'page', type: 'highlight', rects: [{ x: 110, y: 200, w: 30, h: 14 }],
    color: '#ff0', opacity: 0.4,
  }] });
  const out = await PDFDocument.load(result.bytes);
  const copiedPage = out.getPage(0);
  const root = out.catalog.lookup(name('StructTreeRoot'), PDFDict);
  const kids = root.lookup(name('K'), PDFArray);
  const mcr = kids.lookup(0, PDFDict).lookup(name('K'), PDFDict);
  const objr = kids.lookup(1, PDFDict).lookup(name('K'), PDFDict);
  const outer = copiedPage.node.Resources()!.lookup(name('XObject'), PDFDict).get(name('Outer')) as PDFRef;
  const inner = out.context.lookup(outer);
  expect(inner).toHaveProperty('dict');
  const innerResources = (inner as { dict: PDFDict }).dict.lookup(name('Resources'), PDFDict);
  expect(mcr.get(name('Stm'))).toBe(innerResources.lookup(name('XObject'), PDFDict).get(name('F')));
  expect(mcr.get(name('StmOwn'))).toBe(outer);
  expect(objr.get(name('Obj'))).toBe(copiedPage.node.Annots()!.get(0));
  expect(kids.lookup(1, PDFDict).get(name('Pg'))).toBe(copiedPage.ref);
  const parents = root.lookup(name('ParentTree'), PDFDict).lookup(name('Nums'), PDFArray);
  expect(parents.lookup(1, PDFArray).get(0)).toBe(kids.get(0));
  expect(parents.get(3)).toBe(kids.get(1));
});
