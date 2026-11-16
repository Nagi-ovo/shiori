import {expect,test} from 'bun:test';
import {existsSync} from 'node:fs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fixture,model,overlay} from '../../src/pdf/export/contentText/fixtures.test-support';
import type {ContentTextOverlay,PageModel} from '../../src/pdf/model/types';
import type {Type1Options} from '../../src/pdf/export/fontCoverage/type1Support';
import {exportPdf} from '../../src/pdf/export/exportPdf';
import {openPdfium} from '../pdf-inplace/nativePdfium';
import {auditCorpusSample} from './oracle';

// Failure list is in STATUS.md. Exercise saved production bytes with PDFium,
// especially the Tm advance and Tlm that q/cm/Q failed to preserve together.
const library=process.env.SHIORI_PDFIUM_DIR?`${process.env.SHIORI_PDFIUM_DIR}/libpdfium.so`:'vendor/pdfium/linux-x64/lib/libpdfium.so';
const directory='test-artifacts/r23-emit';
const command='bun test scripts/pdf-corpus/retypesetPushEmissionNative.test.ts scripts/pdf-corpus/retypesetPushNative.test.ts';
const loadFont=(name:string)=>readFile(name.startsWith('Noto')?`src/assets/fonts/${name}`:`node_modules/@docx-editor.dev/fonts/assets/${name}`);
const outsiders='170 0 Td (OTHER) Tj T* (NEXT) Tj 0 -16 TD (LAST) Tj';

for(const [name,stream]of [
 ['chained','BT /F1 10 Tf 50 100 Td (AB) Tj (CD) Tj ET'],
 ['clip','q 45 70 130 50 re W n BT /F1 10 Tf 50 100 Td (AB) Tj (CD) Tj ET Q'],
 ['tj','BT /F1 10 Tf 50 100 Td [-200 () -100 (AB) 80 (C) -50 (D) 40] TJ (EF) Tj ET'],
 ['quote',`BT /F1 10 Tf 16 TL 50 116 Td 2 .5 (A B) " (CD) Tj ${outsiders} ET`],
 ['single-quote',`BT /F1 10 Tf 16 TL 50 116 Td (AB) ' (CD) Tj ${outsiders} ET`],
 ['ctm','q 2 0 .4 2 0 0 cm BT /F1 5 Tf 1 Tc 2 Tw 80 Tz 2 Ts .5 0 -.2 1 15 50 Tm (AB) Tj [(C) -50 (D)] TJ ET Q'],
 ['invisible','BT /F1 10 Tf 3 Tr 1 .05 .2 1 50 108 Tm (HIDE) Tj 0 Tr 1 0 0 1 50 100 Tm (AB) Tj (CD) Tj ET'],
] as const){
 test.skipIf(!existsSync(library))(`production push preserves PDFium show origins and following state: ${name}`,async()=>{
  await mkdir(directory,{recursive:true});
  await writeFile(`${directory}/README.md`,`Regenerate: ${command}\nOptional real sample: set RETYPESET_PUSH_R22_SAMPLES to the r22 samples directory.\n`);
  const f=await fixture(`BT /F1 20 Tf 16 TL 50 118 Td (ABCDEFGHIJ) Tj ET ${stream}`);
  const before=await f.doc.save(),edit=overlay({text:'ABCDEFGHIJK',originalText:'ABCDEFGHIJ',coverRects:[{x:49,y:115,w:122,h:24}]}),result=await exportPdf(before,model([edit]),{mode:'flatten',inPlaceFallback:{loadFont}});
  const outcome=result.contentTextOutcomes![0]!;
  await writeFile(`${directory}/${name}.before.pdf`,before);await writeFile(`${directory}/${name}.after.pdf`,result.bytes);
  expect(outcome).toMatchObject({mode:'retypeset',retypeset:{pushed:true,pushedDeltaPt:16}});
  const native=openPdfium(library);
  try{
   const a=native.inspectPage(before),b=native.inspectPage(result.bytes),followers=a.glyphs.slice(10),actual=b.glyphs.slice(11);
   await writeFile(`${directory}/${name}.json`,JSON.stringify({command,stream,outcome,before:followers,after:actual},null,2));
   expect(actual).toHaveLength(followers.length);
   const available=new Set(actual);
   for(const g of followers){
    const delta=g.origin[0]<180?16:0;
    const match=actual.find(h=>available.has(h)&&h.text===g.text&&Math.abs(h.origin[0]-g.origin[0])<.001&&Math.abs(h.origin[1]-(g.origin[1]-delta))<.001);
    expect(match,`${name}: ${g.text} at ${g.origin}, intended delta ${delta}`).toBeDefined();available.delete(match!);
   }
   if(name==='chained'){
    expect(followers.map(g=>g.origin)).toEqual([[50,100],[56,100],[62,100],[68,100]]);
    expect(actual.map(g=>g.origin)).toEqual([[50,84],[56,84],[62,84],[68,84]]);
   }
  }finally{native.close();}
 });
}

const samples=process.env.RETYPESET_PUSH_R22_SAMPLES??'/workspace/shiori-wt/pdf-stage5/test-artifacts/pdf-corpus-r22/samples';
const sample='arxiv-2611.17030-0-overflow';
for(const extended of [false,true])test.skipIf(!existsSync(library)||!existsSync(`${samples}/${sample}.before.pdf`))(`fresh 17030 ${extended?'email-chain':'official'} overflow passes the official native/stream/zero-outside-mask gate`,async()=>{
 await mkdir(directory,{recursive:true});
 const spec=JSON.parse(await readFile(`${samples}/${sample}.edit.json`,'utf8')) as {page:PageModel;overlay:ContentTextOverlay;stage5Type1:Type1Options;stage5Reflow:boolean;stage5Substitute:boolean};
 const name=extended?`${sample}-email-chain`:sample;
 if(extended)spec.overlay={...spec.overlay,text:spec.overlay.text+' in this case'.repeat(4)};
 const before=await readFile(`${samples}/${sample}.before.pdf`),result=await exportPdf(before,{pages:[spec.page],overlays:[spec.overlay]},{mode:'flatten',stage5Type1:spec.stage5Type1,stage5Reflow:spec.stage5Reflow,stage5Substitute:spec.stage5Substitute,inPlaceFallback:{loadFont}});
 const outcome=result.contentTextOutcomes![0]!;
 await writeFile(`${directory}/${name}.before.pdf`,before);await writeFile(`${directory}/${name}.after.pdf`,result.bytes);
 await writeFile(`${directory}/${name}.edit.json`,JSON.stringify({...spec,outcome},null,2));
 expect(outcome).toMatchObject({mode:'retypeset',retypeset:{pushed:true}});
 expect(outcome.retypeset!.pushedDeltaPt).toBeCloseTo(extended?31.88:15.94,6);
 if(extended)expect(outcome.retypeset!.pushedRegions.some(r=>r.before.y<660)).toBe(true);
 const native=openPdfium(library);
 try{
  let checked;
  try{checked=await auditCorpusSample(native,name,directory,spec.overlay,spec.stage5Type1,spec.stage5Reflow,undefined,outcome);}
  catch(error){await writeFile(`${directory}/${name}.report.json`,JSON.stringify({command,outcome,error:String(error)},null,2));throw error;}
  await writeFile(`${directory}/${name}.report.json`,JSON.stringify({command,outcome,checked},null,2));
  expect(checked).toMatchObject({passed:true,oracleTier:'retypeset',changedPixelsOutsideRetypesetMask:0});
  expect(checked.maxOriginDriftPt).toBeLessThan(.001);
  expect(checked.untargetedStreamGlyphs).toBeGreaterThan(0);
 }finally{native.close();}
},60000);
