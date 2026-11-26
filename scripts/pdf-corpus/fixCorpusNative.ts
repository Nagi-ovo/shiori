// Bounded recovery checks, NOT the full corpus. Saved inputs and exact command
// live beside the report. Run: bun scripts/pdf-corpus/fixCorpusNative.ts
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {PDFDocument,PDFDict,PDFName} from 'pdf-lib';
import {openPdfium} from '../pdf-inplace/nativePdfium';
import {buildCorpusOverlays} from './overlays';
import {editMatrix} from './editMatrix';
import {auditCorpusSample} from './oracle';
import {applyContentTextEdits} from '../../src/pdf/export/contentText/apply';
import {fixture,overlay} from '../../src/pdf/export/contentText/fixtures.test-support';
import {spacingPage} from '../../src/pdf/export/contentText/reflowApply.test-support';
import {type1Fixture} from '../../src/pdf/export/contentText/type1Wiring.test-support';
import type {ContentTextOverlay} from '../../src/pdf/model/types';
const directory='test-artifacts/fix-corpus-native',command='bun scripts/pdf-corpus/fixCorpusNative.ts';
await mkdir(directory,{recursive:true});await writeFile(`${directory}/README.md`,`Regenerate: ${command}\n`);
const native=openPdfium(process.env.PDFIUM_LIBRARY??'vendor/pdfium/linux-x64/lib/libpdfium.so'),reports:unknown[]=[];
const loadFont=(name:string)=>readFile(name.startsWith('Noto')?`src/assets/fonts/${name}`:`node_modules/@docx-editor.dev/fonts/assets/${name}`);
try{
 for(const name of ['gsa-3','gsa-13','single-multishow','single-suffix','two-line','distant-image','distant-annotation','tight-cover','new-substitute-wrap','width-substitute-wrap','type1-wmode','type3-scaled'] as const){
  let f:Awaited<ReturnType<typeof spacingPage>>;
  let edit:ContentTextOverlay;
  if(name.startsWith('gsa-')){
   const source=await PDFDocument.load(await readFile(`test-artifacts/pdf-corpus/cache/${name}.pdf`)),doc=await PDFDocument.create(),[p]=await doc.copyPages(source,[0]),page=doc.addPage(p!);
   f={doc,page};const geometry=native.inspectPage(await doc.save()),crop=page.getCropBox();
   const original=buildCorpusOverlays(geometry,{id:'p',sourceIndex:0,widthPt:crop.width,heightPt:crop.height,rotation:0}).find(o=>!o.originalText.includes('\n'))!;
   assert(original);edit={...original,text:editMatrix(original.originalText)[0]!.text};
  }else{
   const single='BT /F1 10 Tf 14 TL 50 150 Td (S ) Tj [(i i ) 0 (i i)] TJ ET';
   f=name==='type1-wmode'?await type1Fixture({programOptions:{clear:'/WMode 0 def'},stream:'BT /F1 10 Tf 14 TL 50 150 Td (AB) Tj ET BT /F1 10 Tf 220 20 Td (C) Tj ET'}):await spacingPage(name==='two-line'?'BT /F1 10 Tf 14 TL 50 150 Td (S i i i i ) Tj 0 -14 Td (S i) Tj ET':name==='tight-cover'?'BT /F1 10 Tf 50 150 Td (S) Tj ET':name==='new-substitute-wrap'?'BT /F1 10 Tf 14 TL 50 150 Td (S i i i i) Tj ET':name==='single-suffix'?'BT /F1 10 Tf 14 TL 50 150 Td (S ) Tj [(i) -1000] TJ ET':single);
   edit=overlay({originalText:'S',text:'n n',coverRects:[{x:49.9,y:148,w:10.2,h:12}]});
   const ctx=f.doc.context;
   if(name==='type1-wmode')edit=overlay({originalText:'AB',text:'CA\nBC',coverRects:[{x:49,y:147,w:14,h:12}]});
   if(name==='width-substitute-wrap'){
    f=await fixture('BT /F1 10 Tf 14 TL 50 100 Td (ABCDE) Tj ET');const font=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict);
    font.delete(PDFName.of('ToUnicode'));font.set(PDFName.of('FontDescriptor'),f.doc.context.obj({FontBBox:[0,-200,600,800],Ascent:800,Descent:-200}));
    edit=overlay({text:'W W W W W W W W',coverRects:[{x:49,y:97,w:32,h:14}]});
   }
   if(name==='type3-scaled'){
    f=await fixture();const font=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict),context=f.doc.context;
    font.set(PDFName.of('Subtype'),PDFName.of('Type3'));font.set(PDFName.of('FontMatrix'),context.obj([.002,0,0,.002,0,0]));font.set(PDFName.of('FontBBox'),context.obj([0,0,600,700]));
    font.set(PDFName.of('CharProcs'),context.obj(Object.fromEntries(Array.from('ABCDE',ch=>[ch,context.register(context.stream('600 0 0 0 500 700 d1 0 0 500 700 re f'))]))));
    font.set(PDFName.of('Resources'),context.obj({}));edit=overlay({text:'AX',coverRects:[{x:49,y:95,w:62,h:24}]});
   }
   if(name==='distant-image'){
    f.page.node.Resources()!.set(PDFName.of('XObject'),ctx.obj({Far:ctx.register(ctx.stream(Uint8Array.of(0),{Type:'XObject',Subtype:'Image',Width:1,Height:1,ColorSpace:'DeviceGray',BitsPerComponent:8}))}));
    const {inspectRunPage}=await import('../../src/pdf/export/contentStreamEdit/replaceRunPage');const s=inspectRunPage(f.page);assert(s.ok);
    f.page.node.set(PDFName.of('Contents'),ctx.register(ctx.flateStream(new TextDecoder().decode(s.bytes)+' q 10 0 0 10 220 20 cm /Far Do Q')));
   }
   if(name==='distant-annotation')f.page.node.set(PDFName.of('Annots'),ctx.obj([{Type:'Annot',Subtype:'Link',Rect:[220,20,240,40]}]));
   if(name==='tight-cover'||name==='new-substitute-wrap'){
    f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict).delete(PDFName.of('ToUnicode'));
    edit=overlay(name==='tight-cover'?{originalText:'S',text:'i',coverRects:[{x:49.5,y:149.5,w:11,h:9}]}:{originalText:'S i i i i',text:'W W W W W W W W',coverRects:[{x:49,y:147,w:51,h:14}]});
   }
  }
  await writeFile(`${directory}/${name}.before.pdf`,await f.doc.save());
  const result=await applyContentTextEdits(f.page,[edit],{loadFont}),outcome=result.outcomes[0]!;
  await writeFile(`${directory}/${name}.edit.json`,JSON.stringify({edit,outcome},null,2));
  assert.equal(outcome.mode,name.startsWith('gsa-')||name==='tight-cover'||name.endsWith('substitute-wrap')||name==='type3-scaled'?'substituted':'reflowed',`${name}: ${JSON.stringify(outcome)}`);
  await writeFile(`${directory}/${name}.after.pdf`,await f.doc.save());
  reports.push(await auditCorpusSample(native,name,directory,edit,{},true,outcome.reflow,outcome.mode));
  console.log(name,'passed');
 }
}finally{native.close();await writeFile(`${directory}/report.json`,JSON.stringify({command,reports},null,2));}
