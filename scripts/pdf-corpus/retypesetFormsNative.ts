// Bounded r21-B reproduction: ONLY the 18 r20 form refusals on three pages.
// No fetching, corpus runner, sample deletion, or changes to cached PDFs.
import {PDFDocument} from 'pdf-lib';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {openPdfium} from '../pdf-inplace/nativePdfium';
import {exportPdf} from '../../src/pdf/export/exportPdf';
import type {PageModel} from '../../src/pdf/model/types';
import {buildCorpusOverlays} from './overlays';
import {editMatrix} from './editMatrix';
import {auditCorpusSample} from './oracle';
import {compareRetypesetNativePages} from './retypesetOracle';
import {assertRetypesetStreamIdentity,retypesetSourceOwnership} from './retypesetStreamOracle';

const cache=process.env.R21_CACHE??'/workspace/shiori-wt/pdf-stage5/test-artifacts/pdf-corpus/cache';
const directory=resolve('test-artifacts/retypeset-forms-native');await mkdir(directory,{recursive:true});
const command='R21_CACHE='+cache+' bun scripts/pdf-corpus/retypesetFormsNative.ts';
await writeFile(`${directory}/README.md`,`Regenerate: ${command}\nOnly the 18 r20 form refusals; page indices are zero-based.\n`);
const native=openPdfium(resolve('vendor/pdfium/linux-x64/lib/libpdfium.so')),rows:unknown[]=[],controls:unknown[]=[];
try{
 for(const [id,pageIndex,multiOnly]of [['arxiv-2611.17052',22,false],['arxiv-2611.17280',20,false],['arxiv-2611.17332',8,true]] as const){
  const original=await PDFDocument.load(await readFile(`${cache}/${id}.pdf`)),single=await PDFDocument.create(),[copy]=await single.copyPages(original,[pageIndex]);
  const target=single.addPage(copy!),before=await single.save(),crop=target.getCropBox();
  const page:PageModel={id:'corpus-page',sourceIndex:0,widthPt:crop.width,heightPt:crop.height,originXPt:crop.x,originYPt:crop.y,rotation:target.getRotation().angle as PageModel['rotation']};
  const overlays=buildCorpusOverlays(native.inspectPage(before),page),one=overlays.find(o=>!o.originalText.includes('\n'))!,multi=overlays.find(o=>o.originalText.includes('\n'));
  assert(one,'missing target line');
  const cases=multiOnly?[]:editMatrix(one.originalText).map(e=>({kind:e.kind,edit:{...one,text:e.text}}));
  if(multi&&id!=='arxiv-2611.17052')cases.push({kind:'multi-line',edit:{...multi,text:editMatrix(multi.originalText.split('\n')[0]!)[0]!.text+'\n'+multi.originalText.split('\n').slice(1).join('\n')}});
  for(const {kind,edit}of cases){
   const name=`${id}-${pageIndex}-${kind}`,result=await exportPdf(before,{pages:[page],overlays:[edit]},{mode:'flatten',inPlaceFallback:{loadFont:name=>readFile(name.startsWith('Noto')?`src/assets/fonts/${name}`:`node_modules/@docx-editor.dev/fonts/assets/${name}`)}});
   const outcome=result.contentTextOutcomes![0]!;
   await writeFile(`${directory}/${name}.before.pdf`,before);await writeFile(`${directory}/${name}.after.pdf`,result.bytes);await writeFile(`${directory}/${name}.edit.json`,JSON.stringify({page,edit,outcome},null,2));
   let oracle:unknown;
   if(outcome.mode!=='unsupported')try{oracle=await auditCorpusSample(native,name,directory,edit,{},true,undefined,outcome);}catch(error){oracle={passed:false,error:String(error)};process.exitCode=1;}
   rows.push({id,page:pageIndex,kind,outcome,oracle});console.log(name,JSON.stringify({outcome,oracle}));
  }
  if(id==='arxiv-2611.17052'){
   // A separate control, not a recovered r20 row: the unchanged paragraph
   // heuristic splits this title at negative kerning adjustments. Address its
   // final three native glyphs so only one existing group is selected.
   const title=native.inspectPage(before).glyphs.filter(g=>g.text.trim()&&one.coverRects.some(r=>g.origin[0]>=r.x&&g.origin[0]<=r.x+r.w&&g.origin[1]>=r.y&&g.origin[1]<=r.y+r.h)).slice(-3);
   assert.equal(title.length,3,'missing addressable control glyphs');
   const x=title[0]!.origin[0]!,right=Math.max(...title.map(g=>g.box[2]!));
   const edit={...one,originalText:title.map(g=>g.text).join(''),text:'real form words',coverRects:[{...one.coverRects[0]!,x:x-.05,w:right-x+.1}]},name=`${id}-${pageIndex}-addressable-control`;
   const result=await exportPdf(before,{pages:[page],overlays:[edit]},{mode:'flatten',inPlaceFallback:{loadFont:name=>readFile(`node_modules/@docx-editor.dev/fonts/assets/${name}`)}}),outcome=result.contentTextOutcomes![0]!;
   await writeFile(`${directory}/${name}.before.pdf`,before);await writeFile(`${directory}/${name}.after.pdf`,result.bytes);await writeFile(`${directory}/${name}.edit.json`,JSON.stringify({page,edit,outcome},null,2));
   const a=native.inspectPage(before,0,true),b=native.inspectPage(result.bytes,0,true),saved=await PDFDocument.load(result.bytes);
   const owned=retypesetSourceOwnership(single.getPage(0),a.glyphs,edit),checked=compareRetypesetNativePages(a,b,edit,outcome.retypeset,owned);
   const nativeEvidence={untargetedGlyphs:checked.untargetedGlyphs,replacementGlyphs:checked.replacementGlyphs,maxOriginDriftPt:checked.maxOriginDriftPt,changedPixelsOutsideRetypesetMask:checked.changedPixelsOutsideRetypesetMask,
    untargetedStreamGlyphs:assertRetypesetStreamIdentity(single.getPage(0),saved.getPage(0),owned)};
   const differences=(text:string,path:string)=>{
    const counts=(s:string)=>{const m=new Map<string,number>();for(const c of s.replace(/\s/gu,''))m.set(c,(m.get(c)??0)+1);return m;};
    const n=counts(text),p=counts(execFileSync('pdftotext',['-layout',path,'-'],{encoding:'utf8'}));
    return [...new Set([...n.keys(),...p.keys()])].filter(c=>n.get(c)!==p.get(c)).map(c=>({scalar:c.codePointAt(0),native:n.get(c)??0,poppler:p.get(c)??0}));
   };
   const extractionDiagnostic={before:differences(a.text,`${directory}/${name}.before.pdf`),after:differences(b.text,`${directory}/${name}.after.pdf`)};
   let oracle:unknown;
   if(outcome.mode!=='unsupported')try{oracle=await auditCorpusSample(native,name,directory,edit,{},true,undefined,outcome);}catch(error){oracle={passed:false,error:String(error)};process.exitCode=1;}
   controls.push({id,page:pageIndex,edit,outcome,nativeEvidence,extractionDiagnostic,oracle});console.log(name,JSON.stringify({outcome,nativeEvidence,extractionDiagnostic}));
  }
 }
 assert.equal(rows.length,18,'bounded form reproduction case count changed');
}finally{native.close();await writeFile(`${directory}/report.json`,JSON.stringify({command,rows,controls},null,2));}
