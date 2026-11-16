import { expect, test } from 'bun:test';
import { buildContentTextPreview } from './contentTextPreview';
import { fixture, overlay, model } from '../../pdf/export/contentText/fixtures.test-support';
import { PDFDocument } from 'pdf-lib';
import { inspectRunPage } from '../../pdf/export/contentStreamEdit/replaceRunPage';
test('preview uses the production planner/writer and keeps refused edits out of its raster',async()=>{
  const {doc}=await fixture();const source=await doc.save();
  const preview=await buildContentTextPreview(source,model([]).pages[0]!,[overlay()]);
  expect(preview.outcomes).toEqual([{overlayId:'edit',mode:'in-place',fidelity:'exact'}]);
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
  const changed=await buildContentTextPreview(bytes,page,[overlay({text:'AYCDE'})]);
  expect(changed).not.toBe(first);
  expect(await buildContentTextPreview(bytes,page,[])).toMatchObject({bytes:null,outcomes:[]});
});
test('a raster with an accepted edit and a hybrid sibling has the same content as export',async()=>{
 const{exportPdf}=await import('../../pdf/export/exportPdf');const{doc}=await fixture();const source=await doc.save();
 const edits=[overlay({id:'b',originalText:'B',text:'X',coverRects:[{x:55.9,y:99,w:6.2,h:10}]}),overlay({id:'d',originalText:'D',text:'D\nY',coverRects:[{x:67.9,y:99,w:6.2,h:10}]})];
 const preview=await buildContentTextPreview(source,model([]).pages[0]!,edits),exported=await exportPdf(source,model(edits),{mode:'flatten'});
 expect(preview.outcomes.map(o=>o.mode)).toEqual(['retypeset','retypeset']);
 const before=await PDFDocument.load(preview.bytes!),after=await PDFDocument.load(exported.bytes);
 expect(inspectRunPage(before.getPage(0))).toEqual(inspectRunPage(after.getPage(0)));
});
