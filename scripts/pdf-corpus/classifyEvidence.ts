import {PDFDocument} from 'pdf-lib';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {openPdfium} from '../pdf-inplace/nativePdfium';
import {fetchEntry,readManifest} from './fetch';
import {buildCorpusOverlays} from './overlays';
import {missingHanEdit} from './missingHan';
import {inspectRunPage,resolveRunFonts,runPageEnvironment} from '../../src/pdf/export/contentStreamEdit/replaceRunPage';
import {editMatrix} from './editMatrix';
import type {PageModel} from '../../src/pdf/model/types';
import {tokenizeContentStream} from '../../src/pdf/export/contentStreamEdit/tokenizer';
import {walkTextPlacements} from '../../src/pdf/export/contentStreamEdit/textState';
import {removalsByRect} from '../../src/pdf/export/contentStreamEdit/removeGlyphs';
import {runContextSafety} from '../../src/pdf/export/contentStreamEdit/replaceRun';
import {explainEvidence} from './evidenceGate';
import type {OverflowClassification,EvidenceClassification} from './classifyTypes';
const hist=JSON.parse(await readFile(resolve(process.env.OVERFLOW_HISTOGRAM??'test-artifacts/pdf-corpus/overflow-histogram.json'),'utf8')) as {rows:OverflowClassification[]};
const needed=hist.rows.filter((r)=>r.gate==='no-region-proof');
const native=openPdfium(resolve('vendor/pdfium/linux-x64/lib/libpdfium.so'));
const allEntries=await readManifest();
const out:EvidenceClassification[]=[];
const stage5Type1={sourceReuse:true};
try{
 for(const entry of allEntries){
  const rows=needed.filter((r)=>r.id===entry.id);if(!rows.length)continue;
  const bytes=await fetchEntry(entry),pdf=await PDFDocument.load(bytes,{ignoreEncryption:true});
  for(const pageIndex of new Set(rows.map((r)=>r.page))){
   const single=await PDFDocument.create();const [copied]=await single.copyPages(pdf,[pageIndex]);const target=single.addPage(copied!);
   const before=await single.save(),geometry=native.inspectPage(before),crop=target.getCropBox();
   const page:PageModel={id:'corpus-page',sourceIndex:0,widthPt:crop.width,heightPt:crop.height,originXPt:crop.x,originYPt:crop.y,rotation:target.getRotation().angle as PageModel['rotation']};
   const overlays=buildCorpusOverlays(geometry,page);
   const one=overlays.find(o=>!o.originalText.includes('\n') && (entry.category!=='chinese' || /\p{Script=Han}/u.test(o.originalText)));
   const multi=overlays.find(o=>o.originalText.includes('\n'));
   if(!one)continue;
   const cases=editMatrix(one.originalText).map(e=>({edit:{...one,text:e.text},kind:e.kind}));
   if(entry.category==='chinese'){
    const content=inspectRunPage(target);
    const missing=content.ok?missingHanEdit(content.bytes,resolveRunFonts(target,stage5Type1),one):null;
    if(missing)cases.push({edit:{...one,text:missing.text},kind:missing.kind});
   }
   if(multi){const first=editMatrix(multi.originalText.split('\n')[0]!)[0];if(first)cases.push({edit:{...multi,text:first.text+'\n'+multi.originalText.split('\n').slice(1).join('\n')},kind:'multi-line'});}
   const fonts=resolveRunFonts(target,stage5Type1),environment=runPageEnvironment(target),source=inspectRunPage(target);
   if(!source.ok)continue;
   const ops=tokenizeContentStream(source.bytes),safety=runContextSafety(ops,environment);
   const walk=walkTextPlacements(ops,{resolveFont:name=>{const f=fonts.find(f=>f.resourceName===name);return f?{...f,ok:true as const,appliesWordSpacing:f.bytesPerCode===1}:{ok:false as const,reason:'unmeasurable'};},extGStateSetsFont:name=>environment.extGStates?.get(name)?.setsFont??null});
   for(const c of cases){
    const row=rows.find((r)=>r.page===pageIndex&&r.kind===c.kind);if(!row)continue;
    let gate:{gate:string;blocker?:string;detail?:string};
    try{
     if(!walk.ok||!safety.ok){gate={gate:'pre-evidence-walk',detail:walk.ok?safety.reason:walk.reason};}
     else {
      const selected=[...new Set(removalsByRect(walk.glyphs,c.edit.coverRects).flatMap(h=>[...h]))];
      if(!selected.length)gate={gate:'no-selected'};
      else gate=explainEvidence(target,source.bytes,fonts,selected[0]!.opIndex,stage5Type1);
     }
    }catch(error){gate={gate:'classifier-error',detail:String(error)};}
    out.push({...row,evidenceGate:gate.gate,evidenceBlocker:gate.blocker,evidenceDetail:gate.detail});
   }
  }
  console.log(entry.id, out.filter(r=>r.id===entry.id).length);
 }
}finally{native.close();}
const dest=resolve(process.env.OVERFLOW_EVIDENCE??'test-artifacts/pdf-corpus/overflow-evidence.json');
await writeFile(dest,JSON.stringify({count:out.length,rows:out},null,2));
const tally=(fn:(r:EvidenceClassification)=>string)=>{const m=new Map<string,number>();for(const r of out){const k=fn(r);m.set(k,(m.get(k)??0)+1);}return [...m.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));};
const md=['# Production no-region-proof evidence subgates',`Rows: ${out.length}`,'','## By evidence gate','',...tally(r=>r.evidenceGate).map(([k,n])=>`- ${k}: ${n}`),'','## By evidence gate × blocker','',...tally(r=>`${r.evidenceGate} / ${r.evidenceBlocker??"none"}`).map(([k,n])=>`- ${k}: ${n}`),'','## By category × evidence gate','',...tally(r=>`${r.category} / ${r.evidenceGate}`).map(([k,n])=>`- ${k}: ${n}`),'','## Sample details',
 ...tally(r=>`${r.category} / ${r.evidenceGate} / ${(r.evidenceDetail??'').slice(0,120)}`).slice(0,25).map(([k,n])=>`- ${k}: ${n}`)].join('\n');
await writeFile(dest.replace(/\.json$/,'.md'),md);
console.log(md);
