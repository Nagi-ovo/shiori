import { expect, test } from 'bun:test';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { buildContentTextPreview } from '../../../editor/components/contentTextPreview';
import { inspectRunPage } from '../contentStreamEdit/replaceRunPage';
import { fixture, model, overlay } from '../contentText/fixtures.test-support';
import { exportPdf } from '../exportPdf';

const baselines = [150, 135, 120, 105];
const spans = Array.from('!?+-', (glyph, mcid) =>
  `/Span << /MCID ${mcid} >> BDC q BT /F1 10 Tf 1 0 0 1 50 ${baselines[mcid]} Tm (${glyph}) Tj ET Q EMC`,
).join('\n');
const permutation = overlay({
  originalText: '!?+-', text: '?+!-',
  coverRects: baselines.map(y => ({ x: 49, y: y - 3, w: 10, h: 13 })),
});
const options = { mode: 'annotations', preserveSourceAnnotations: true } as const;
const padding = [49, 158.2, 59, 159.8];
const far = [200, 158.2, 210, 159.8];

// Paragraph padding and gaps count even when no glyph paints there.
// Refusals retain the source annotation order and identifiers in both entry points.
test.each(['review', 'strict'] as const)('an anchored span permutation is refused in %s export and preview', async acceptance => {
  const { doc, page } = await fixture(spans);
  const ctx = doc.context;
  const link = ctx.register(ctx.obj({ Subtype: 'Link', Rect: padding }));
  page.node.set(PDFName.of('Annots'), ctx.obj([
    link,
    ctx.register(ctx.obj({ Subtype: 'Link', Rect: far })),
    ctx.obj({ Subtype: 'Square', Rect: [58, 131, 50, 130] }),
  ]));
  const source = await doc.save({ useObjectStreams: false });
  const requested = model([permutation]);
  const policy = { ...options, acceptance };
  const result = await exportPdf(source, requested, policy);
  const preview = await buildContentTextPreview(source, requested.pages[0]!, [permutation], undefined, undefined, policy);
  expect(result.contentTextOutcomes).toEqual([{
    overlayId: permutation.id, mode: 'unsupported', reason: 'annotation-anchor', pageIndex: 0,
    detail: `annotation ${link} Link, annotation direct:2 Square`,
    anchoredAnnotations: [
      { ref: link.toString(), subtype: 'Link', kind: 'link', rect: padding },
      { ref: 'direct:2', subtype: 'Square', kind: 'markup', rect: [50, 130, 58, 131] },
    ],
  }]);
  const verdict = {
    policy: acceptance, status: acceptance === 'strict' ? 'refused' : 'needs-review',
    findings: [{ kind: 'unexcised-edit', count: 1 }],
  };
  expect(result.bytes).toEqual(source);
  expect(result.unexcisedEdits).toBe(1);
  expect(result.acceptance).toMatchObject(verdict);
  expect(preview.outcomes).toEqual(result.contentTextOutcomes!);
  expect(preview.bytes).toBeNull();
  expect(preview.acceptance).toMatchObject(verdict);
});

test.each([['no link', undefined], ['a distant link', far]] as const)(
  'a span permutation with %s still installs and preserves its MCIDs', async (_label, rect) => {
    const { doc, page } = await fixture(spans);
    if (rect) page.node.addAnnot(doc.context.register(doc.context.obj({ Subtype: 'Link', Rect: rect })));
    const result = await exportPdf(await doc.save(), model([permutation]), options);
    expect(result.contentTextOutcomes).toMatchObject([{ mode: 'retypeset' }]);
    expect(result.acceptance.status).toBe('accepted');
    expect(result.semanticChanges?.map(row => [row.dependency.mcid, row.action])).toEqual([
      [0, 'preserved'], [1, 'preserved'], [2, 'preserved'],
    ]);
  },
);

test('a link intersecting destination ink keeps the semantic refusal', async () => {
  const { doc, page } = await fixture(spans);
  page.node.addAnnot(doc.context.register(doc.context.obj({ Subtype: 'Link', Rect: [49, 157, 59, 158.5] })));
  const source = await doc.save();
  const result = await exportPdf(source, model([permutation]), options);
  expect(result.contentTextOutcomes).toEqual([{
    overlayId: permutation.id, mode: 'unsupported', reason: 'semantic-dependency', pageIndex: 0,
  }]);
  expect(result.semanticChanges).toContainEqual(expect.objectContaining({
    overlayId: permutation.id, action: 'refused', reason: 'semantic-partial-span',
  }));
  expect(result.unexcisedEdits).toBe(1);
  expect(result.bytes).toEqual(source);
});

test('an anchored permutation leaves independent text on the same page editable', async () => {
  const { doc, page } = await fixture(`${spans}\nBT /F1 10 Tf 200 40 Td (ABCDE) Tj ET`);
  const link = doc.context.register(doc.context.obj({ Subtype: 'Link', Rect: padding }));
  page.node.addAnnot(link);
  const source = await doc.save();
  const independent = overlay({ id: 'independent', coverRects: [{ x: 199, y: 38, w: 32, h: 13 }] });
  const result = await exportPdf(source, model([permutation, independent]), options);
  expect(result.contentTextOutcomes).toMatchObject([
    { overlayId: permutation.id, mode: 'unsupported', reason: 'annotation-anchor', pageIndex: 0,
      anchoredAnnotations: [{ ref: link.toString(), subtype: 'Link', kind: 'link', rect: padding }] },
    { overlayId: independent.id, mode: 'in-place', pageIndex: 0 },
  ]);
  expect(result.unexcisedEdits).toBe(1);
  const control = await exportPdf(source, model([independent]), options);
  const [saved, expected] = await Promise.all([result.bytes, control.bytes].map(async bytes => {
    const page = (await PDFDocument.load(bytes)).getPage(0);
    const run = inspectRunPage(page);
    if (!run.ok) throw Error(run.reason);
    return { bytes: run.bytes, annotation: page.node.Annots()!.lookup(0, PDFDict).toString() };
  }));
  expect(saved).toEqual(expected!);
});
