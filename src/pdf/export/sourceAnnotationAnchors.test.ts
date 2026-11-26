import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { buildContentTextPreview } from '../../editor/components/contentTextPreview';
import type { ContentTextOverlay, SourceImageEditOverlay } from '../model/types';
import { fixture, model, overlay } from './contentText/fixtures.test-support';
import { inspectRunPage } from './contentStreamEdit/replaceRunPage';
import { exportPdf } from './exportPdf';
import { listSourceImages } from './sourceImages';
import { planLinkedFlow } from './contentText/flow/flowPlan';
import { buildFlow, linkedFlowStory } from './contentText/flow/linkedFlow.test-support';

// Failure cases: an anchored edit might install, or its blocked compilation
// might still change the page or widget. An independent edit on the same
// page must survive. The gap between image placements and clipped-off paint
// must never count as affected area. A stale address keeps its refusal.
test('a mixed flattened export keeps the original widget and page text at its anchor', async () => {
  const { doc, page } = await fixture('BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET BT /F1 10 Tf 200 150 Td (ABCDE) Tj ET');
  const field = doc.getForm().createTextField('reference');
  field.setText('Widget value');
  field.addToPage(page, { x: 50, y: 98, width: 25, height: 12 });
  const source = await doc.save({ useObjectStreams: false });
  const original = await PDFDocument.load(source);
  const ref = original.getPage(0).node.Annots()!.get(0).toString();
  const anchored = overlay({ text: 'many additional words' });
  const independent = overlay({ id: 'second', text: 'AXCDE', coverRects: [{ x: 199, y: 148, w: 32, h: 13 }] });
  const options = { mode: 'flatten' as const, preserveSourceAnnotations: true, stage5Reflow: false };
  const result = await exportPdf(source, model([anchored, independent]), options);
  const control = await exportPdf(source, model([independent]), options);
  expect(result.contentTextOutcomes?.map(o => [o.mode, o.reason])).toEqual([
    ['unsupported', 'annotation-anchor'], ['in-place', undefined],
  ]);
  expect(result.contentTextOutcomes?.[0]?.anchoredAnnotations).toMatchObject([{ ref, subtype: 'Widget', kind: 'widget' }]);
  const output = await PDFDocument.load(result.bytes);
  const stream = (page: Parameters<typeof inspectRunPage>[0]) => {
    const run = inspectRunPage(page);
    if (!run.ok) throw Error(run.reason);
    return new TextDecoder().decode(run.bytes);
  };
  expect(stream(output.getPage(0))).toBe(stream((await PDFDocument.load(control.bytes)).getPage(0)));
  expect(stream(output.getPage(0))).toContain('(ABCDE)');
  expect(stream(output.getPage(0))).not.toContain('Widget value');
  expect(output.getForm().getTextField('reference').getText()).toBe('Widget value');

  const widget = (pdf: PDFDocument) => pdf.getPage(0).node.Annots()!.lookup(0, PDFDict);
  const appearance = (node: PDFDict) => {
    const normal = node.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'), PDFRawStream);
    return decodePDFRawStream(normal).decode();
  };
  const savedWidget = widget(output);
  expect(output.getPage(0).node.Annots()!.size()).toBe(1);
  expect(savedWidget.get(PDFName.of('Subtype'))).toEqual(PDFName.of('Widget'));
  expect(savedWidget.lookup(PDFName.of('Rect'), PDFArray).toString()).toBe(widget(original).lookup(PDFName.of('Rect'), PDFArray).toString());
  expect(appearance(savedWidget)).toEqual(appearance(widget(original)));
});

test('an image move only anchors the original visible paint and the destination box', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  page.setCropBox(20, 15, 260, 165);
  const ctx = doc.context;
  const image = ctx.register(ctx.flateStream(Uint8Array.of(100), {
    Type: 'XObject', Subtype: 'Image', Width: 1, Height: 1, ColorSpace: 'DeviceGray', BitsPerComponent: 8,
  }));
  page.node.set(PDFName.of('Resources'), ctx.obj({ XObject: { Image: image } }));
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream('q 60 70 20 30 re W n 40 0 0 30 40 70 cm /Image Do Q')));
  const annot = (rect: number[], subtype = 'Link') => ctx.obj({ Subtype: subtype, Rect: rect });
  const annots = ctx.obj([annot([44, 74, 50, 90]), annot([110, 74, 120, 90]), annot([170, 70, 175, 100], 'Popup')]);
  page.node.set(PDFName.of('Annots'), annots);
  const modelPage = { ...model([]).pages[0]!, widthPt: 260, heightPt: 165, originXPt: 20, originYPt: 15 };
  const source = await doc.save();
  const [target] = await listSourceImages(source, 0);
  const edit: SourceImageEditOverlay = { id: 'move', type: 'sourceImageEdit', pageId: modelPage.id, target: target!,
    rect: { x: 130, y: 55, w: 40, h: 30 }, crop: { x: .5, y: 0, w: .5, h: 1 } };
  const save = (bytes: Uint8Array, overlay: SourceImageEditOverlay) =>
    exportPdf(bytes, { pages: [modelPage], overlays: [overlay] }, { preserveSourceAnnotations: true });
  expect((await save(source, edit)).sourceImageOutcomes).toEqual([{ overlayId: 'move', mode: 'applied' }]);
  annots.push(annot([178, 90, 174, 74], 'Underline'));
  const blocked = await doc.save();
  const result = await save(blocked, edit);
  expect(result.sourceImageOutcomes).toEqual([{ overlayId: 'move', mode: 'unsupported', reason: 'annotation-anchor',
    detail: 'annotation direct:3 Underline', anchoredAnnotations: [
      { ref: 'direct:3', kind: 'markup', subtype: 'Underline', rect: [174, 74, 178, 90] },
    ] }]);
  expect(result.bytes).toEqual(blocked);
  const stale = await save(blocked, { ...edit, target: { ...edit.target, fingerprint: 'stale' } });
  expect(stale.sourceImageOutcomes).toEqual([{ overlayId: 'move', mode: 'unsupported', reason: 'stale-source' }]);
});

// A link or markup can anchor blank space in a changed frame. An annotation
// in the gap does not anchor either frame, and a chain that already fails
// its paint proof must still report that proof failure.
test.each(['Highlight', 'Link'])('a %s over the spill frame is reported by export, preview, and dry run', async subtype => {
  const f = await buildFlow({ ...linkedFlowStory, annots: [{ subtype, rect: 'second' }] }, readFileSync);
  const source = await PDFDocument.load(f.bytes);
  const ref = source.getPage(0).node.Annots()!.get(0).toString();
  const { x, y, w, h } = f.frames[1];
  const refusal = { reason: 'annotation-anchor', detail: `annotation ${ref} ${subtype}`,
    anchoredAnnotations: [{ ref, subtype, kind: subtype === 'Link' ? 'link' : 'markup', rect: [x, y, x + w, y + h] }] };
  const plan = await planLinkedFlow(f.bytes, f.model, 'chain-1');
  expect(plan).toMatchObject({ ok: false, ...refusal });
  for (const acceptance of ['strict', 'review'] as const) {
    const options = { acceptance, mode: 'annotations' as const, preserveSourceAnnotations: true };
    const saved = await exportPdf(f.bytes, f.model, options);
    const preview = await buildContentTextPreview(f.bytes, f.model.pages[0]!, [f.model.overlays[0] as ContentTextOverlay],
      undefined, undefined, { ...options, flowChains: f.model.flowChains });
    expect(saved.bytes).toEqual(f.bytes);
    expect(saved.contentTextOutcomes).toEqual([{
      overlayId: 'flow-edit', pageIndex: 0, mode: 'unsupported', ...refusal,
    }]);
    expect(preview.outcomes).toEqual(saved.contentTextOutcomes!);
  }
});

test('a link between the frames leaves both placements available', async () => {
  const f = await buildFlow({ ...linkedFlowStory, annots: [{ subtype: 'Link', rect: { x: 80, y: 419.5, w: 100, h: 2 } }] }, readFileSync);
  const plan = await planLinkedFlow(f.bytes, f.model, 'chain-1');
  expect(plan.ok).toBe(true);
});

test('a link over the spill frame keeps an existing paint obstacle refusal', async () => {
  const f = await buildFlow({ ...linkedFlowStory, annots: [{ subtype: 'Link', rect: 'second' }],
    rule: { x: 60, y: 400, w: 180, h: 0 } }, readFileSync);
  const plan = await planLinkedFlow(f.bytes, f.model, 'chain-1');
  expect(plan).toMatchObject({ ok: false, reason: 'flow-destination-obstacle' });
});

