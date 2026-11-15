// Regenerate saved-PDF apply evidence: bun research/reflow-proto/nativeApply.ts
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {openPdfium} from '../../scripts/pdf-inplace/nativePdfium';
import {auditCorpusSample} from '../../scripts/pdf-corpus/oracle';
import {applyContentTextEdits} from '../../src/pdf/export/contentText/apply';
import {runResourceStamp} from '../../src/pdf/export/contentStreamEdit/resourceStamp';
import {overlay} from '../../src/pdf/export/contentText/fixtures.test-support';
import {spacingPage,requestPage} from '../../src/pdf/export/contentText/reflowApply.test-support';
import {fullReflowStream,cidReflowPage,cffReflowPage} from '../../src/pdf/export/contentText/reflowFull.test-support';
import type {ReflowRequest} from '../../src/pdf/export/contentText/reflowTypes';
import {PDFDict,PDFName,PDFObjectCopier} from 'pdf-lib';
import {inspectRunPage,resolveRunFonts} from '../../src/pdf/export/contentStreamEdit/replaceRunPage';
import {planStreamReflow} from '../../src/pdf/export/contentText/reflowAuto';
import {replaceRunPageWithFallback} from '../../src/pdf/export/contentStreamEdit/fallbackPage';
import {reflowManifest} from '../../src/pdf/export/contentText/reflowManifest';
import {tokenizeContentStream} from '../../src/pdf/export/contentStreamEdit/tokenizer';
import {walkTextPlacements} from '../../src/pdf/export/contentStreamEdit/textState';
const out=resolve('test-artifacts/reflow-full-native');await mkdir(out,{recursive:true});
const native=openPdfium(process.env.PDFIUM_LIBRARY??'/workspace/shiori-wt/pdf-inplace-ui/vendor/pdfium/linux-x64/lib/libpdfium.so');
const reports=[];
try{
 for(const name of ['spacing','suffix','wrap','auto-suffix','auto-wrap','auto-grow','cid-wrap','fallback-wrap','type1-wrap','first-indent','hanging-indent','leading-tj','same-bt','hard-crlf','substitute-wrap','explicit-substitute','cff-wrap'] as const){
  const automatic=!['spacing','suffix','wrap','explicit-substitute'].includes(name);
  const f=name==='cff-wrap'?await cffReflowPage(new Uint8Array(await readFile('src/assets/fonts/NotoSansSC-Regular.otf'))):name==='spacing'?await spacingPage():name==='cid-wrap'||name==='fallback-wrap'?await cidReflowPage(undefined,name==='cid-wrap'?'F1':'ShioriFb1'):
   name==='type1-wrap'||!automatic?await requestPage():await spacingPage(name==='first-indent'?fullReflowStream('S i',50,60):name==='hanging-indent'?
    'BT /F1 10 Tf 14 TL 1 0 0 1 40 150 Tm (S i i i i i ) Tj 1 0 0 1 50 136 Tm (S i i i i ) Tj 1 0 0 1 50 122 Tm (S i) Tj ET':
    name==='leading-tj'?fullReflowStream('S i',50,60).replace('1 0 0 1 60 150 Tm (S i i i ) Tj','1 0 0 1 50 150 Tm [-1000 (S i i i )] TJ'):
    name==='same-bt'?fullReflowStream().replace(' ET',' 1 0 0 1 200 108 Tm (i) Tj ET'):
    fullReflowStream(name==='auto-grow'?'S i i i i':'S i'));
  let edit=overlay({originalText:'S',text:'an',coverRects:[{x:49.9,y:98,w:10.2,h:12}]}),request:ReflowRequest|undefined;
  if('request'in f){request=automatic?undefined:f.request;edit={...f.overlay,text:'甲乙'};
   if(request){
   request.replacementInk=['甲','乙'].map((unicode,i)=>({unicode,code:Uint8Array.of(i+1),box:{x:1,y:-2,w:8,h:10},proofHash:'synthetic-outline-hull'}));
   if(name==='suffix'){request.target={...request.paragraph.lines[2]!.shows[0]!.source,byteStart:1,byteEnd:2};request.softBreaks=[];
    edit={...edit,originalText:'乙',coverRects:[{x:59.9,y:670,w:10.2,h:10}]};}
   }
  }
  if(automatic&&name!=='type1-wrap'){
   const y=name==='auto-suffix'||name==='hard-crlf'?122:150,x=name==='first-indent'||name==='leading-tj'?60:name==='hanging-indent'?40:50;
   edit=overlay({originalText:'S',text:name==='hard-crlf'?'n\r\nn':'n n',coverRects:[{x:x-.1,y:y-2,w:10.2,h:12}]});
  }
  if('edit'in f)edit=overlay(f.edit);
  if(name==='substitute-wrap'||name==='explicit-substitute'){
   const cid=await cidReflowPage(),copier=PDFObjectCopier.for(cid.doc.context,f.doc.context);
   const from=cid.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict),dict=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict);
   dict.set(PDFName.of('ShioriSub1'),copier.copy(from.get(PDFName.of('F1'))!));
   if(request){
    edit={...edit,text:'n n'};request.replacementFontResource='ShioriSub1';
    request.replacementInk=['n',' '].map(unicode=>({unicode,code:Uint8Array.of(0,unicode.charCodeAt(0)),box:unicode===' '?{x:0,y:0,w:0,h:0}:{x:0,y:0,w:1,h:1},proofHash:'glyf-hull'}));
   }
  }
  await writeFile(resolve(out,`${name}.before.pdf`),await f.doc.save());
  if(request){const hash=runResourceStamp(f.page);request.dependencyHash=hash;request.paragraph.dependencyHash=hash;request.paragraph.evidence.dependencyHash=hash;}
  const result=name==='substitute-wrap'?await (async()=>{
   const source=inspectRunPage(f.page);assert(source.ok);const fonts=resolveRunFonts(f.page),font=fonts.find(f=>f.resourceName==='ShioriSub1')!;
   const plan=planStreamReflow(f.page,source.bytes,fonts,edit,{stage5Reflow:true},{},font);assert(plan?.reflow);
   const walk=walkTextPlacements(tokenizeContentStream(source.bytes),{resolveFont:name=>{const font=fonts.find(f=>f.resourceName===name);return font?{...font,ok:true,appliesWordSpacing:font.bytesPerCode===1}:null;}});assert(walk.ok);
   const compiled=await replaceRunPageWithFallback(f.page,plan);assert(compiled.ok);
   return {outcomes:[{mode:'substituted',reflow:reflowManifest(plan.reflow,walk.glyphs,fonts)}]};
  })():await applyContentTextEdits(f.page,[edit],{stage5Reflow:true,stage5Type1:{sourceReuse:true},reflowRequests:request?new Map([[edit.id,request]]):undefined});
  assert.equal(result.outcomes[0]?.mode,name==='spacing'?'in-place':name==='substitute-wrap'||name==='explicit-substitute'?'substituted':'reflowed',JSON.stringify(result.outcomes));const manifest=result.outcomes[0]!.reflow;assert(manifest);
  assert.equal(manifest.strategy,name==='spacing'?'spacing-only':name==='suffix'||name==='auto-suffix'?'suffix-shift':'wrap');
  await writeFile(resolve(out,`${name}.after.pdf`),await f.doc.save());
  await writeFile(resolve(out,`${name}.edit.json`),JSON.stringify({edit,manifest},null,2));
  const checked=await auditCorpusSample(native,name,out,edit,{},true,manifest);reports.push(checked);
 }
 const refusals=[];
 for(const name of ['flag-off','occupied-band','crop-bottom'] as const){
  const f=await spacingPage(fullReflowStream('S i i i i')+(name==='occupied-band'?' BT /F1 10 Tf 1 0 0 1 60 108 Tm (i) Tj ET':''));
  if(name==='crop-bottom')f.page.setCropBox(0,115,300,85);
  const edit=overlay({originalText:'S',text:'n n',coverRects:[{x:49.9,y:148,w:10.2,h:12}]});
  const before=await f.doc.save(),source=inspectRunPage(f.page);
  const result=await applyContentTextEdits(f.page,[edit],{stage5Reflow:name!=='flag-off'});
  assert.equal(result.outcomes[0]?.mode,'overlay');assert.equal(result.outcomes[0]?.reason,'overflow');assert.deepEqual(inspectRunPage(f.page),source);
  const beforePath=resolve(out,`${name}.before.pdf`),afterPath=resolve(out,`${name}.after.pdf`);
  await writeFile(beforePath,before);await writeFile(afterPath,await f.doc.save());
  const old=native.inspectPage(beforePath,0,true),saved=native.inspectPage(afterPath,0,true);
  const stable=(glyphs:typeof old.glyphs)=>glyphs.map(({object:_,...g})=>{void _;return g;});
  assert.deepEqual(old.pixels,saved.pixels);assert.deepEqual(stable(old.glyphs),stable(saved.glyphs));
  refusals.push({name,reason:'overflow',unchangedSource:true,changedPixels:0,passed:true});
 }
 await writeFile(resolve(out,'report.json'),JSON.stringify({command:'bun research/reflow-proto/nativeApply.ts',reports,refusals},null,2));
 console.log(JSON.stringify(reports));
}finally{native.close();}
