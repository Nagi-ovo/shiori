import {expect,test} from 'bun:test';
import {existsSync} from 'node:fs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {PDFDocument} from 'pdf-lib';
import {fixture,model,overlay} from '../../src/pdf/export/contentText/fixtures.test-support';
import {exportPdf} from '../../src/pdf/export/exportPdf';
import {openPdfium} from '../pdf-inplace/nativePdfium';
import {auditCorpusSample} from './oracle';

// Full official-gate failures: pushed followers and a small rule need both
// source and destination masks plus stream deltas; unclaimed shifts and real
// outsider text/paint changes must still fail. No corpus samples are added.
const library=process.env.SHIORI_PDFIUM_DIR?`${process.env.SHIORI_PDFIUM_DIR}/libpdfium.so`:'vendor/pdfium/linux-x64/lib/libpdfium.so';
const directory='test-artifacts/r23-oracle/synthetic';
test.skipIf(!existsSync(library))('official oracle accepts a production push with a small rule and rejects outsiders',async()=>{
 await mkdir(directory,{recursive:true});
 const command='bun test scripts/pdf-corpus/retypesetPushNative.test.ts';
 await writeFile(`${directory}/README.md`,`Regenerate: ${command}\nSynthetic production export, official native/stream/raster/qpdf/Poppler gate and negative controls.\n`);
 const f=await fixture('BT /F1 20 Tf 24 TL 50 150 Td (ABCDEFGHIJ) Tj ET BT /F1 10 Tf 55 120 Td (Release) Tj ET 0 g 80 90 3 .4 re f BT /F1 10 Tf 220 120 Td (OTHER) Tj ET');
 const before=await f.doc.save(),edit=overlay({text:'ABCDEFGHIJK',originalText:'ABCDEFGHIJ',coverRects:[{x:49,y:147,w:122,h:24}]}),result=await exportPdf(before,model([edit]),{
  mode:'flatten',inPlaceFallback:{loadFont:name=>readFile(`node_modules/@docx-editor.dev/fonts/assets/${name}`)},
 });
 const outcome=result.contentTextOutcomes![0]!;
 expect(outcome).toMatchObject({mode:'retypeset',retypeset:{pushed:true,pushedDeltaPt:24}});
 expect(outcome.retypeset!.pushedRegions.some(r=>r.before.w<4&&r.before.h<1)).toBe(true);
 for(const name of ['push','unclaimed','outsider-text','outsider-ink'])await writeFile(`${directory}/${name}.before.pdf`,before);
 await writeFile(`${directory}/push.after.pdf`,result.bytes);
 await writeFile(`${directory}/unclaimed.after.pdf`,result.bytes);
 const native=openPdfium(library),controls=[];
 try{
  const checked=await auditCorpusSample(native,'push',directory,edit,{},true,undefined,outcome);
  expect(checked).toMatchObject({passed:true,oracleTier:'retypeset',maxOriginDriftPt:0,changedPixelsOutsideRetypesetMask:0});
  expect(checked.untargetedStreamGlyphs).toBeGreaterThan(0);
  await expect(auditCorpusSample(native,'unclaimed',directory,edit,{},true,undefined,{...outcome,retypeset:{...outcome.retypeset!,pushed:false,pushedDeltaPt:0,pushedRegions:[]}})).rejects.toThrow('untargeted');
  for(const name of ['outsider-text','outsider-ink']){
   const bad=await PDFDocument.load(result.bytes),page=bad.getPage(0);
   page.node.addContentStream(bad.context.register(bad.context.stream(name==='outsider-text'?'BT /F1 10 Tf 220 80 Td (Z) Tj ET':'0 g 225 70 2 2 re f')));
   await writeFile(`${directory}/${name}.after.pdf`,await bad.save());
   let error='';try{await auditCorpusSample(native,name,directory,edit,{},true,undefined,outcome);}catch(e){error=String(e);}
   expect(error).toMatch(name==='outsider-text'?/requested local text mismatch/:/outside retypeset mask/);
   controls.push({name,passed:false,error});
  }
  await writeFile(`${directory}/report.json`,JSON.stringify({command,outcome,checked,controls},null,2));
 }finally{native.close();}
});
