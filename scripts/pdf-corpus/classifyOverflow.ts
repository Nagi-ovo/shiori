// Diagnostic only: classify why overflow rows did not reflow. Does not modify PDFs.
import {PDFDocument} from 'pdf-lib';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {openPdfium} from '../pdf-inplace/nativePdfium';
import {fetchEntry,readManifest} from './fetch';
import {buildCorpusOverlays} from './overlays';
import {missingHanEdit} from './missingHan';
import {inspectRunPage,resolveRunFonts,runPageEnvironment} from '../../src/pdf/export/contentStreamEdit/replaceRunPage';
import {editMatrix} from './editMatrix';
import type {PageModel,ContentTextOverlay} from '../../src/pdf/model/types';
import {runContextSafety,type ResolvedRunFont} from '../../src/pdf/export/contentStreamEdit/replaceRun';
import {removalsByRect} from '../../src/pdf/export/contentStreamEdit/removeGlyphs';
import {tokenizeContentStream} from '../../src/pdf/export/contentStreamEdit/tokenizer';
import {walkTextPlacements} from '../../src/pdf/export/contentStreamEdit/textState';
import {planStreamReflow} from '../../src/pdf/export/contentText/reflowAuto';
import {streamReflowEvidence,proveDownwardSlot} from '../../src/pdf/export/contentText/reflowEvidence';
import {encodeRun} from '../../src/pdf/export/contentStreamEdit/runEncoding';
import {legalMeasuredBreak,solveMeasuredReflow} from '../../src/pdf/export/contentText/reflowLayout';
import {linear} from '../../src/pdf/export/contentText/regionProof/geometry';
import {reflowEnabled} from '../../src/pdf/export/contentText/reflowTypes';
import type {CorpusRow} from './report';
import type {OverflowClassification} from './classifyTypes';
const normalize=(s:string)=>s.replace(/\r\n?/g,'\n');
type Gate={gate:string;detail?:string};
function explain(page:import('pdf-lib').PDFPage,content:Uint8Array,fonts:readonly ResolvedRunFont[],overlay:ContentTextOverlay,environment:ReturnType<typeof runPageEnvironment>,type1:{sourceReuse:boolean}):Gate{
 if(!reflowEnabled(true)||!overlay.sourceStyle)return {gate:'style-or-flag',detail:'missing sourceStyle or reflow disabled'};
 if(overlay.angle||overlay.align!=='left'||Object.entries(overlay.sourceStyle).some(([k,v])=>overlay[k as keyof ContentTextOverlay]!==v))
  return {gate:'style-or-flag',detail:'angle/align/style change'};
 const ops=tokenizeContentStream(content),safety=runContextSafety(ops,environment);
 if(!safety.ok)return {gate:'run-context-unsafe',detail:safety.reason};
 const walk=walkTextPlacements(ops,{resolveFont:name=>{const f=fonts.find(f=>f.resourceName===name);return f?{...f,ok:true as const,appliesWordSpacing:f.bytesPerCode===1}:{ok:false as const,reason:'unmeasurable source font'};},extGStateSetsFont:name=>environment.extGStates?.get(name)?.setsFont??null});
 if(!walk.ok)return {gate:'placement-walk-failed',detail:walk.reason};
 const selected=[...new Set(removalsByRect(walk.glyphs,overlay.coverRects).flatMap(h=>[...h]))];
 if(!selected.length)return {gate:'no-addressable-glyphs'};
 if(selected.some(g=>safety.unsafe.has(g.opIndex)))return {gate:'selected-unsafe-ops'};
 const e=streamReflowEvidence(page,content,fonts,selected[0]!.opIndex,type1);
 if(!e.ok){
  const uniqueY=new Set(selected.map(g=>Math.round(g.coreQuad[0].y*100)));
  return {gate:'no-region-proof',detail:`${e.gate}${e.blocker?`/${e.blocker}`:''}: ${e.detail}; selected=${selected.length} uniqueY=${uniqueY.size}`};
 }
 const indices=e.source.flatMap((t,i)=>selected.some(g=>g.opIndex===t.source!.opIndex&&g.arrayItemIndex===t.source!.itemIndex&&g.byteOffset===t.source!.byteStart)?[i]:[]);
 if(indices.length!==selected.length)return {gate:'selection-not-in-proof',detail:`selected=${selected.length} inProof=${indices.length} proofLines=${e.lines.length} proofBT=${e.proof.bt}`};
 if(indices.some((v,i)=>i>0&&v!==indices[i-1]!+1))return {gate:'non-contiguous-operator-tail',detail:`indices=${indices.join(',')}`};
 const start=indices[0]!,end=indices.at(-1)!+1,old=e.source.slice(start,end),first=old[0]!;
 const original=normalize(overlay.originalText),replacementText=normalize(overlay.text);
 const sourceLines:string[]=[];
 for(const t of old){const row=t.original!.line-old[0]!.original!.line;sourceLines[row]=(sourceLines[row]??'')+t.unicode;}
 if(original!==sourceLines.join('\n')&&!(original.indexOf('\n')<0&&original===sourceLines.join('')))
  return {gate:'source-text-mismatch',detail:`overlay=${JSON.stringify(original.slice(0,80))} stream=${JSON.stringify(sourceLines.join('\\n').slice(0,80))}`};
 const state=e.trace.shows.get(`${first.source!.opIndex}:${first.source!.itemIndex}`)!.before;
 const sourceFont=fonts.find(f=>f.resourceName===first.fontResource);
 if(!sourceFont||old.some(t=>t.fontObject!==sourceFont.objectId)||Math.abs(overlay.fontSize-first.em)>.05)
  return {gate:'mixed-font-or-size',detail:`em=${first.em} overlay=${overlay.fontSize}`};
 const font=sourceFont;
 const replacement=[];
 for(const {segment} of new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(replacementText)){
  if(segment==='\n'){
   if(!replacement.length||(replacement.at(-1) as {hardAfter?:boolean}).hardAfter)return {gate:'illegal-hard-break'};
   (replacement.at(-1) as {hardAfter?:boolean}).hardAfter=true;continue;
  }
  const encoded=encodeRun(segment,font,Uint8Array.from(old.flatMap(t=>[...t.code])));
  if(!encoded.ok||encoded.codes.length!==1)return {gate:'encode-failed',detail:!encoded.ok?encoded.reason:'multi-code cluster'};
  const code=font.bytesPerCode===1?encoded.bytes[0]!:encoded.bytes[0]!*256+encoded.bytes[1]!;
  const measured=e.ink(font.resourceName,code,state);
  if(!measured)return {gate:'replacement-ink-unproved',detail:segment};
  const scale=linear(state)[0]!*state.tz/100;
  const advance=(font.widthOf(code)*state.size/1000+state.tc+(font.bytesPerCode===1&&code===32?state.tw:0))*scale;
  replacement.push({...first,fontResource:font.resourceName,fontObject:font.objectId,unicode:segment,advance,ink:measured.box,code:encoded.bytes,source:undefined,original:undefined,glyph:measured.glyph,
   wordSpace:font.bytesPerCode===1&&code===32,fullEmHan:font.widthOf(code)===1000,gap:0,hardAfter:false});
 }
 if(!replacement.length||(replacement.at(-1) as {hardAfter?:boolean}).hardAfter)return {gate:'empty-or-trailing-hard-break'};
 const softBreaks:number[]=[];
 for(let i=0;i<e.source.length-1;i++){
  const a=e.source[i]!,b=e.source[i+1]!;
  if(a.original!.line!==b.original!.line&&legalMeasuredBreak(a,b))softBreaks.push(a.original!.line);
 }
 let proof=e.proof,layout=solveMeasuredReflow({source:e.source,replacement,start,end,proof,softBreaks});
 let grew=0;
 while(!layout.ok&&layout.code==='overflow'){
  const grown=proveDownwardSlot(e,proof);if(!grown)break;
  proof=grown;layout=solveMeasuredReflow({source:e.source,replacement,start,end,proof,softBreaks});grew++;
 }
 if(!layout.ok||layout.strategy==='fixed'){
  const why=!layout.ok?layout.code:'fixed';
  return {gate:why==='overflow'?(grew?'grow-down-still-overflow':'grow-down-space-not-proved'):'layout-refused',detail:`strategy=${'strategy'in layout?layout.strategy:why} grew=${grew} lines=${e.lines.length} leading=${e.proof.leadingPt}${e.visualGroup.columnEvidence?` column=${JSON.stringify(e.visualGroup.columnEvidence)}`:''}`};
 }
 if(layout.strategy!=='wrap'&&proof!==e.proof)return {gate:'growth-not-allowed-for-strategy',detail:layout.strategy};
 const recipe=planStreamReflow(page,content,fonts,overlay,{...environment,stage5Reflow:true},type1);
 if(!recipe)return {gate:'plan-stream-reflow-null-after-layout-ok'};
 return {gate:'reflow-planned-but-export-still-overflowed',detail:recipe.reflow?.layout.strategy};
}

const stage5Type1={sourceReuse:true};
const report=JSON.parse(await readFile(resolve(process.env.OVERFLOW_REPORT??'test-artifacts/pdf-corpus-r5/report.json'),'utf8')) as {rows:CorpusRow[]};
const overflow=new Set(report.rows.filter((r)=>r.outcome?.reason==='overflow').map((r)=>`${r.id}|${r.page}|${r.kind}`));
const rows=report.rows.filter((r)=>r.outcome?.reason==='overflow');
const native=openPdfium(resolve('vendor/pdfium/linux-x64/lib/libpdfium.so'));
const allEntries=await readManifest();
const out:OverflowClassification[]=[];
const started=performance.now();
try{
 for(const entry of allEntries){
  const needed=rows.filter((r)=>r.id===entry.id);
  if(!needed.length)continue;
  const bytes=await fetchEntry(entry),pdf=await PDFDocument.load(bytes,{ignoreEncryption:true});
  const pages=new Set(needed.map((r)=>r.page));
  for(const pageIndex of pages){
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
   for(const c of cases){
    const key=`${entry.id}|${pageIndex}|${c.kind}`;
    if(!overflow.has(key))continue;
    const row=needed.find((r)=>r.page===pageIndex&&r.kind===c.kind);
    let gate:Gate;
    try{
     if(!source.ok)gate={gate:'inspect-failed',detail:source.reason};
     else gate=explain(target,source.bytes,fonts,c.edit,environment,stage5Type1);
    }catch(error){gate={gate:'classifier-error',detail:String(error)};}
    out.push({id:entry.id,category:entry.category,page:pageIndex,kind:c.kind,detail:row?.outcome?.detail,gate:gate.gate,gateDetail:gate.detail});
   }
  }
  console.log(entry.id, out.filter(r=>r.id===entry.id).length);
 }
}finally{native.close();}
const dest=resolve(process.env.OVERFLOW_HISTOGRAM??'test-artifacts/pdf-corpus/overflow-histogram.json');
await mkdir(dirname(dest),{recursive:true});
await writeFile(dest,JSON.stringify({elapsedMs:performance.now()-started,count:out.length,rows:out},null,2));
const tally=(fn:(r:OverflowClassification)=>string)=>{
 const m=new Map<string,number>();
 for(const r of out){const k=fn(r);m.set(k,(m.get(k)??0)+1);}
 return [...m.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
};
const md=['# Overflow reflow-decline histogram','',`Rows classified: ${out.length} / ${rows.length}`,'', '## By gate','',
 ...tally(r=>r.gate).map(([k,n])=>`- ${k}: ${n}`),'','## By category × gate','',
 ...tally(r=>`${r.category} / ${r.gate}`).map(([k,n])=>`- ${k}: ${n}`),'','## By outcome detail × gate','',
 ...tally(r=>`${r.detail} / ${r.gate}`).map(([k,n])=>`- ${k}: ${n}`)].join('\n');
await writeFile(dest.replace(/\.json$/,'.md'),md);
console.log(md);
console.log('Wrote', dest);
