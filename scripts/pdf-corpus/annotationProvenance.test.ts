import { expect, test } from 'bun:test';
import { PDFDocument, PDFName, PDFRef } from 'pdf-lib';
import { fixture, model, overlay } from '../../src/pdf/export/contentText/fixtures.test-support';
import { exportPdf } from '../../src/pdf/export/exportPdf';
import { corpusReportOutcome } from './annotationProvenance';

// Copying can change object number order and generation. Equal rectangles can
// belong to distinct annotations, and repeated entries must remain repeated.
// Non-blocking entries still occupy slots used to identify direct annotations.
test('a corpus refusal names each original while the sample names its own annotations', async () => {
  const { doc, page } = await fixture();
  doc.insertPage(0, [300, 200]);
  const context = doc.context;
  const link = () => context.obj({ Subtype: 'Link', Rect: [70, 105, 54, 98] });
  const first = PDFRef.of(91, 7), second = PDFRef.of(42, 3);
  context.assign(first, link());
  context.assign(second, link());
  const outside = context.obj({ Subtype: 'Link', Rect: [200, 150, 210, 160] });
  page.node.set(PDFName.of('Annots'), context.register(context.obj([first, outside, link(), second, first, link()])));

  const original = await PDFDocument.load(await doc.save({ useObjectStreams: false }));
  const sample = await PDFDocument.create();
  const [copied] = await sample.copyPages(original, [1]);
  const samplePage = sample.addPage(copied!);
  const before = await sample.save();
  const result = await exportPdf(before, model([overlay({ text: 'many additional words' })]), {
    mode: 'flatten', stage5Reflow: false,
  });
  const outcome = result.contentTextOutcomes![0]!;
  const sampleAnnots = (await PDFDocument.load(before)).getPage(0).node.Annots()!;
  const sampleFirst = sampleAnnots.get(0) as PDFRef;
  const sampleSecond = sampleAnnots.get(3) as PDFRef;
  expect(sampleFirst.objectNumber).toBeLessThan(sampleSecond.objectNumber);
  expect([sampleFirst.generationNumber, sampleSecond.generationNumber]).toEqual([0, 0]);

  const annotations = (refs: string[]) => refs.map(ref => ({ ref, subtype: 'Link', kind: 'link', rect: [54, 98, 70, 105] }));
  const detail = (refs: string[]) => refs.map(ref => `annotation ${ref} Link`).join(', ');
  const sampleRefs = [String(sampleFirst), 'direct:2', String(sampleSecond), String(sampleFirst), 'direct:5'];
  const originalRefs = ['91 7 R', 'direct:2', '42 3 R', '91 7 R', 'direct:5'];
  const sampleOutcome = { overlayId: 'edit', mode: 'unsupported', reason: 'annotation-anchor',
    anchoredAnnotations: annotations(sampleRefs), detail: detail(sampleRefs) };
  expect(outcome).toMatchObject(sampleOutcome);
  expect(result.bytes).toEqual(before);

  const reported = corpusReportOutcome(outcome, original.getPage(1), samplePage);
  expect(reported).toEqual({ ...outcome, anchoredAnnotations: annotations(originalRefs), detail: detail(originalRefs) });
  expect(outcome).toMatchObject(sampleOutcome);
});

test('a report preserves outcomes without annotation anchors', async () => {
  const { doc, page } = await fixture();
  const sample = await PDFDocument.create();
  const [copied] = await sample.copyPages(doc, [0]);
  const samplePage = sample.addPage(copied!);
  const before = await sample.save();
  const accepted = await exportPdf(before, model([overlay()]), { mode: 'flatten' });
  const refused = await exportPdf(before, model([overlay({ originalText: 'HDJUF' })]), { mode: 'flatten' });
  const installed = accepted.contentTextOutcomes![0]!;
  const unsupported = refused.contentTextOutcomes![0]!;
  expect(installed).toMatchObject({ mode: 'in-place', fidelity: 'exact' });
  expect(unsupported.mode).toBe('unsupported');
  expect(unsupported.anchoredAnnotations).toBeUndefined();
  expect(corpusReportOutcome(installed, page, samplePage)).toEqual(installed);
  expect(corpusReportOutcome(unsupported, page, samplePage)).toEqual(unsupported);
});
