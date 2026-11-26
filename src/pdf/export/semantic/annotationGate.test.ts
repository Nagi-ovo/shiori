import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PDFDocument, PDFDict, PDFName, PDFString } from 'pdf-lib';
import type { PDFPage } from 'pdf-lib';
import { buildContentTextPreview } from '../../../editor/components/contentTextPreview';
import { importFileAnnotations } from '../../import/annotations';
import { fixture, model, overlay } from '../contentText/fixtures.test-support';
import { buildFlow, linkedFlowStory } from '../contentText/flow/linkedFlow.test-support';
import { planLinkedFlow } from '../contentText/flow/flowPlan';
import { exportPdf } from '../exportPdf';
import { listSourceImages } from '../sourceImages';

const name = PDFName.of;

function tagHighlight(page: PDFPage) {
  const { doc } = page, ctx = doc.context;
  const annot = page.node.Annots()!.get(0);
  page.node.Annots()!.lookup(0, PDFDict).set(name('StructParent'), ctx.obj(1));
  const root = ctx.nextRef();
  const owner = ctx.register(ctx.obj({ S: 'Annot', P: root, Pg: page.ref, K: { Type: 'OBJR', Obj: annot } }));
  ctx.assign(root, ctx.obj({ Type: 'StructTreeRoot', K: owner, ParentTree: { Nums: [1, owner] } }));
  doc.catalog.set(name('StructTreeRoot'), root);
}

async function liveHighlight(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  const ref = doc.catalog.lookup(name('StructTreeRoot'), PDFDict)
    .lookup(name('K'), PDFDict).lookup(name('K'), PDFDict).get(name('Obj'));
  expect(doc.getPage(0).node.Annots()!.asArray()).toEqual([ref!]);
  const annotation = doc.context.lookup(ref, PDFDict);
  expect(annotation.get(name('StructParent'))?.toString()).toBe('1');
}

test('the default export and preview keep one live OBJR annotation while both text edits install', async () => {
  const { doc, page } = await fixture(
    'BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET BT /F1 10 Tf 50 40 Td (FGHIJ) Tj ET q 5 0 0 5 140 10 cm /Image Do Q',
  );
  const ctx = doc.context;
  page.node.Resources()!.set(name('XObject'), ctx.obj({
    Image: ctx.register(ctx.stream(Uint8Array.of(90), {
      Subtype: 'Image', Width: 1, Height: 1, ColorSpace: 'DeviceGray', BitsPerComponent: 8,
    })),
  }));
  for (const y of [70, 55]) {
    const t = y + 10;
    page.node.addAnnot(doc.context.register(doc.context.obj({
      Type: 'Annot', Subtype: 'Highlight', Rect: [40, y, 100, t], P: page.ref,
      QuadPoints: [40, t, 100, t, 40, y, 100, y], C: [1, 1, 0], Contents: PDFString.of('First comment'),
    })));
  }
  const edits = [
    overlay({ id: 'top' }),
    overlay({ id: 'bottom', originalText: 'FGHIJ', text: 'FGTIJ', coverRects: [{ x: 49, y: 38, w: 32, h: 13 }] }),
  ];
  const requested = model(edits);
  const untagged = await exportPdf(await doc.save(), requested);
  expect((await PDFDocument.load(untagged.bytes)).getPage(0).node.Annots()?.size() ?? 0).toBe(0);

  tagHighlight(page);
  const source = await doc.save();
  const result = await exportPdf(source, requested);
  expect(result.contentTextOutcomes).toMatchObject([{ mode: 'in-place' }, { mode: 'in-place' }]);
  expect(result.acceptance.status).toBe('accepted');
  await liveHighlight(result.bytes);
  expect((await exportPdf(result.bytes, model([]))).bytes).toEqual(result.bytes);

  const [target] = await listSourceImages(source, 0);
  const mixed = await exportPdf(source, {
    ...requested,
    overlays: [...edits, { id: 'remove-image', pageId: requested.pages[0]!.id, type: 'sourceImageEdit', target: target!, delete: true }],
  });
  expect(mixed.contentTextOutcomes).toMatchObject([{ mode: 'in-place' }, { mode: 'in-place' }]);
  expect(mixed.sourceImageOutcomes).toMatchObject([{ mode: 'applied' }]);
  await liveHighlight(mixed.bytes);
  const preview = await buildContentTextPreview(source, requested.pages[0]!, edits);
  expect(preview.outcomes).toEqual(result.contentTextOutcomes);
  await liveHighlight(preview.bytes!);

  const [first] = await importFileAnnotations(requested.pages, source);
  expect(first?.type).toBe('highlight');
  if (first?.type !== 'highlight') throw Error('missing imported highlight');
  const restored = { ...requested, overlays: [...edits, first] };
  await liveHighlight((await exportPdf(source, restored)).bytes);
  expect((await exportPdf(source, restored, { mode: 'flatten' })).bytes)
    .toEqual((await exportPdf(source, requested, { mode: 'flatten' })).bytes);
  const edited = { ...restored, overlays: [...edits, { ...first, comment: 'Updated comment', localActivityAt: Date.now() }] };
  for (const mode of ['annotations', 'flatten'] as const) {
    const { bytes } = await exportPdf(source, edited, { mode });
    await liveHighlight(bytes);
    expect((await importFileAnnotations(requested.pages, bytes))[0]).toMatchObject({ comment: 'Updated comment' });
  }

  const removed = await exportPdf(source, requested, { mode: 'none' });
  expect((await PDFDocument.load(removed.bytes)).getPage(0).node.Annots()).toBeUndefined();
});

test('linked dry run and export retain an unrelated annotation referenced by OBJR', async () => {
  const f = await buildFlow({
    ...linkedFlowStory, annots: [{ subtype: 'Highlight', rect: { x: 60, y: 80, w: 100, h: 10 } }],
  }, path => readFileSync(path));
  const doc = await PDFDocument.load(f.bytes);
  tagHighlight(doc.getPage(0));
  const source = await doc.save();
  expect(await planLinkedFlow(source, f.model, 'chain-1')).toMatchObject({ ok: true });
  const out = await exportPdf(source, f.model);
  expect(out.contentTextOutcomes).toMatchObject([{ mode: 'retypeset' }]);
  expect(out.acceptance.status).toBe('accepted');
  await liveHighlight(out.bytes);
});
