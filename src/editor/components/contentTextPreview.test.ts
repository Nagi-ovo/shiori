import { expect, test } from 'bun:test';
import { buildContentTextPreview } from './contentTextPreview';
import { fixture, overlay, model } from '../../pdf/export/contentText/fixtures.test-support';
import { PDFDocument } from 'pdf-lib';
import { inspectRunPage } from '../../pdf/export/contentStreamEdit/replaceRunPage';
import { cjkJpExportFontUrl, cjkScExportFontUrl } from '../../pdf/export/fontAssets';
import { exportPdf, type ExportOptions } from '../../pdf/export/exportPdf';

// A preview can miss a writer counter, treat a discarded candidate as clean,
// or reuse a verdict after its source, model, options, or services change.
const writerOptions = {
  mode: 'flatten',
  unicodeFontUrl: cjkScExportFontUrl,
  unicodeJpFontUrl: cjkJpExportFontUrl,
} satisfies ExportOptions;
test('preview uses the production planner/writer and keeps refused edits out of its raster',async()=>{
  const {doc}=await fixture();const source=await doc.save();
  const preview=await buildContentTextPreview(source,model([]).pages[0]!,[overlay()]);
  expect(preview.outcomes).toEqual([{overlayId:'edit',pageIndex:0,mode:'in-place',fidelity:'exact'}]);
  const pdf=await PDFDocument.load(preview.bytes!);const content=inspectRunPage(pdf.getPage(0));
  expect(content.ok).toBe(true);if(content.ok)expect(new TextDecoder().decode(content.bytes)).toContain('58');
  const refused=await buildContentTextPreview(source,model([]).pages[0]!,[overlay({text:'AB\nCDE'})]);
  expect(refused.outcomes).toMatchObject([{overlayId:'edit',mode:'retypeset',fidelity:'approximate',retypeset:{reason:'reflow-required'}}]);
  expect(refused.bytes).not.toBeNull();
});
test('cache identity includes source revision, crop/rotation and every overlay value',async()=>{
  const {doc}=await fixture();const bytes=await doc.save(),page=model([]).pages[0]!;
  const first=await buildContentTextPreview(bytes,page,[overlay()]);
  expect(await buildContentTextPreview(bytes,page,[overlay()])).toBe(first);
  expect(await buildContentTextPreview(bytes.slice(),{...page},[overlay({localActivityAt:1})],undefined,undefined,{
    acceptance:'review', stage5Substitute:true, stage5Reflow:true,
  })).toBe(first);
  for (const patch of [{text:'AYCDE'}, {fontSize:12}, {fontFamily:'sans'}] as const) {
    const changed=await buildContentTextPreview(bytes,page,[overlay(patch)]);
    expect(changed.acceptance.key).not.toBe(first.acceptance.key);
  }
  const rotated=await buildContentTextPreview(bytes,{...page,rotation:90},[overlay()]);
  expect(rotated.acceptance.key).not.toBe(first.acceptance.key);
  const other=await fixture('BT /F1 10 Tf 50 100 Td (ABCDE) Tj 0 -20 Td (OTHER) Tj ET');
  const revision=await buildContentTextPreview(await other.doc.save(),page,[overlay()]);
  expect(revision.acceptance.key).not.toBe(first.acceptance.key);
  const empty=await buildContentTextPreview(bytes,page,[]);
  bytes[7]=bytes[7]===55?54:55;
  expect((await buildContentTextPreview(bytes,page,[])).acceptance.key).not.toBe(empty.acceptance.key);
});

test('effective writer options and service changes invalidate the cached verdict', async () => {
  const {doc}=await fixture(), bytes=await doc.save(), page=model([]).pages[0]!;
  const edits=[overlay()];
  const readSourceGlyphs=async()=>[];
  const renderContentText=async()=>{ throw Error('Renderer unavailable'); };
  const options={ readSourceGlyphs, renderContentText, stage5Reflow:true };
  const preview=(overrides:ExportOptions={})=>buildContentTextPreview(bytes,page,edits,undefined,undefined,{...options,...overrides});
  const first=await preview();
  expect(await preview()).toBe(first);
  for (const overrides of [
    { acceptance:'strict' }, { stage5Reflow:false }, { stage5Substitute:false },
    { readSourceGlyphs:async()=>[] }, { renderContentText:async()=>{ throw Error('Renderer unavailable'); } },
    { inPlaceFallback:{ loadFont:async()=>new Uint8Array() } },
  ] satisfies ExportOptions[]) {
    expect((await preview(overrides)).acceptance.key).not.toBe(first.acceptance.key);
  }
});

test('clean, empty, blank, and unsupported previews carry the page export verdict', async () => {
  const {doc}=await fixture(), bytes=await doc.save(), page=model([]).pages[0]!;
  const blank={...page,sourceIndex:-1,blank:true};
  const cases=[
    {page, edits:[overlay()], kinds:[]},
    {page, edits:[], kinds:[]},
    {page:blank, edits:[], kinds:[]},
    {page:blank, edits:[overlay()], kinds:['unexcised-edit']},
    {page, edits:[overlay({originalText:'WRONG'})], kinds:['unexcised-edit']},
  ];
  for (const scenario of cases) {
    const preview=await buildContentTextPreview(bytes,scenario.page,scenario.edits);
    const exported=await exportPdf(bytes,{pages:[scenario.page],overlays:scenario.edits},writerOptions);
    expect(preview.acceptance).toEqual(exported.acceptance);
    expect(preview.acceptance.findings.map(f=>f.kind)).toEqual(scenario.kinds);
    if (scenario.page===blank || scenario.kinds.length || !scenario.edits.length) expect(preview.bytes).toBeNull();
  }
});

test('a selected strict policy withholds the edit and keeps the stripped-equivalent finding', async () => {
  const {doc}=await fixture('/Span <</ActualText (Expanded label)>> BDC BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET EMC');
  const bytes=await doc.save(), edits=[overlay()], edited=model(edits), page=edited.pages[0]!;
  const review=await buildContentTextPreview(bytes,page,edits);
  expect(review.acceptance).toMatchObject({
    status:'needs-review', findings:[{kind:'stripped-equivalent',overlayId:'edit',pageIndex:0}],
    notes:[{kind:'approximate-fidelity',overlayId:'edit'}],
  });
  expect(review.bytes).not.toBeNull();
  const options={...writerOptions,acceptance:'strict' as const};
  const strict=await buildContentTextPreview(bytes,page,edits,undefined,undefined,options);
  expect(strict.acceptance).toEqual((await exportPdf(bytes,edited,options)).acceptance);
  expect(strict.acceptance.status).toBe('refused');
  expect(strict.acceptance.findings).toContainEqual({kind:'stripped-equivalent',overlayId:'edit',pageIndex:0});
  expect(strict.outcomes).toMatchObject([{mode:'unsupported',reason:'acceptance-strict'}]);
  expect(strict.bytes).toBeNull();
});
test('a raster with an accepted edit and a hybrid sibling has the same content as export',async()=>{
 const{doc}=await fixture();const source=await doc.save();
 const edits=[overlay({id:'b',originalText:'B',text:'X',coverRects:[{x:55.9,y:99,w:6.2,h:10}]}),overlay({id:'d',originalText:'D',text:'D\nY',coverRects:[{x:67.9,y:99,w:6.2,h:10}]})];
 const preview=await buildContentTextPreview(source,model([]).pages[0]!,edits),exported=await exportPdf(source,model(edits),{mode:'flatten'});
 expect(preview.outcomes.map(o=>o.mode)).toEqual(['retypeset','retypeset']);
 const before=await PDFDocument.load(preview.bytes!),after=await PDFDocument.load(exported.bytes);
 expect(inspectRunPage(before.getPage(0))).toEqual(inspectRunPage(after.getPage(0)));
});
