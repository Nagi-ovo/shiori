// Regenerate saved-PDF apply evidence: bun research/reflow-proto/nativeApply.ts
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {openPdfium} from '../../scripts/pdf-inplace/nativePdfium';
import {auditCorpusSample} from '../../scripts/pdf-corpus/oracle';
import {applyContentTextEdits} from '../../src/pdf/export/contentText/apply';
import {runResourceStamp} from '../../src/pdf/export/contentStreamEdit/resourceStamp';
import {overlay} from '../../src/pdf/export/contentText/fixtures.test-support';
import {spacingPage,requestPage} from '../../src/pdf/export/contentText/reflowApply.test-support';
import type {ReflowRequest} from '../../src/pdf/export/contentText/reflowTypes';
const out=resolve('test-artifacts/finish-native');await mkdir(out,{recursive:true});
const native=openPdfium(process.env.PDFIUM_LIBRARY??'/workspace/shiori-wt/pdf-inplace-ui/vendor/pdfium/linux-x64/lib/libpdfium.so');
const reports=[];
try{
 for(const name of ['spacing','suffix','wrap'] as const){
  const f=name==='spacing'?await spacingPage():await requestPage();
  let edit=overlay({originalText:'S',text:'an',coverRects:[{x:49.9,y:98,w:10.2,h:12}]}),request:ReflowRequest|undefined;
  if('request'in f){request=f.request;edit={...f.overlay,text:'甲乙'};
   request.replacementInk=['甲','乙'].map((unicode,i)=>({unicode,code:Uint8Array.of(i+1),box:{x:1,y:-2,w:8,h:10},proofHash:'synthetic-outline-hull'}));
   if(name==='suffix'){request.target={...request.paragraph.lines[2]!.shows[0]!.source,byteStart:1,byteEnd:2};request.softBreaks=[];
    edit={...edit,originalText:'乙',coverRects:[{x:59.9,y:670,w:10.2,h:10}]};}
  }
  await writeFile(resolve(out,`${name}.before.pdf`),await f.doc.save());
  if(request){const hash=runResourceStamp(f.page);request.dependencyHash=hash;request.paragraph.dependencyHash=hash;request.paragraph.evidence.dependencyHash=hash;}
  const result=await applyContentTextEdits(f.page,[edit],{stage5Reflow:true,reflowRequests:request?new Map([[edit.id,request]]):undefined});
  assert.equal(result.outcomes[0]?.mode,'in-place',JSON.stringify(result.outcomes));const manifest=result.outcomes[0]!.reflow;assert(manifest);
  assert.equal(manifest.strategy,name==='spacing'?'spacing-only':name==='suffix'?'suffix-shift':'wrap');
  await writeFile(resolve(out,`${name}.after.pdf`),await f.doc.save());
  await writeFile(resolve(out,`${name}.edit.json`),JSON.stringify({edit,manifest},null,2));
  const checked=await auditCorpusSample(native,name,out,edit,{},true,manifest);reports.push(checked);
 }
 await writeFile(resolve(out,'report.json'),JSON.stringify({command:'bun research/reflow-proto/nativeApply.ts',reports},null,2));
 console.log(JSON.stringify(reports));
}finally{native.close();}
