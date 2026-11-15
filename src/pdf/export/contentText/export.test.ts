import { expect, test } from 'bun:test';
import { PDFDocument } from 'pdf-lib';
import { exportPdf } from '../exportPdf';
import { inspectRunPage } from '../contentStreamEdit/replaceRunPage';
import { tokenizeContentStream } from '../contentStreamEdit/tokenizer';
import { fixture, model, overlay } from './fixtures.test-support';
for(const mode of ['flatten','annotations'] as const) test(`export rewrites original show without an appended text object (${mode})`,async()=>{
  const {doc}=await fixture(); const result=await exportPdf(await doc.save(),model([overlay()]),{mode});
  expect(result.contentTextOutcomes).toEqual([{overlayId:'edit',mode:'in-place'}]);
  const out=await PDFDocument.load(result.bytes);const source=inspectRunPage(out.getPage(0));
  expect(source.ok).toBe(true);if(!source.ok)return;
  const ops=tokenizeContentStream(source.bytes);
  expect(ops.filter(o=>o.operator==='BT')).toHaveLength(1);
  expect(ops.filter(o=>o.operator==='re')).toHaveLength(0);
  expect(new TextDecoder().decode(source.bytes)).toContain('58');
});
test('overflow refuses the whole overlay and reports the hybrid path',async()=>{
  const {doc}=await fixture();const result=await exportPdf(await doc.save(),model([overlay({text:'AXXXXXCDE'})]),{mode:'flatten'});
  expect(result.contentTextOutcomes).toMatchObject([{overlayId:'edit',mode:'overlay',reason:'overflow'}]);
  const out=await PDFDocument.load(result.bytes);const source=inspectRunPage(out.getPage(0));
  if(!source.ok)throw Error(source.reason);
  expect(tokenizeContentStream(source.bytes).filter(o=>o.operator==='BT').length).toBeGreaterThan(1);
});
test('a failed second line never partially changes the first line',async()=>{
  const {doc}=await fixture('BT /F1 10 Tf 50 100 Td (ABCDE) Tj 0 -20 Td (FGHIJ) Tj ET');
  const edit=overlay({originalText:'ABCDE\nFGHIJ',text:'AXCDE\nFGXXXXHIJ',coverRects:[{x:49,y:98,w:32,h:13},{x:49,y:78,w:32,h:13}]});
  const result=await exportPdf(await doc.save(),model([edit]),{mode:'flatten'});
  expect(result.contentTextOutcomes).toMatchObject([{overlayId:'edit',mode:'overlay',reason:'overflow'}]);
});
test('the export boundary embeds a verified fallback for a genuinely missing source glyph',async()=>{
 const bytes=new Uint8Array(await Bun.file('scripts/pdf-inplace/fixtures/subset.pdf').arrayBuffer());
 const source=await PDFDocument.load(bytes),p=source.getPage(0);
 const edit=overlay({originalText:'Sans',text:'Sanr',fontSize:20,rect:{x:19,y:95,w:50,h:22},coverRects:[{x:19,y:95,w:50,h:22}]});
 const result=await exportPdf(bytes,{pages:[{...model([]).pages[0]!,widthPt:p.getWidth(),heightPt:p.getHeight()}],overlays:[edit]},
 {mode:'flatten',inPlaceFallback:{loadFont:async name=>new Uint8Array(await Bun.file(`node_modules/@docx-editor.dev/fonts/assets/${name}`).arrayBuffer())}});
 expect(result.contentTextOutcomes).toEqual([{overlayId:'edit',mode:'fallback-font'}]);
});
