// Read-only replay of selected retypeset rows from an official corpus report.
// Each row regenerates its single-page input from the verified cache, rebuilds
// the same overlay the corpus picked, runs the production exporter and records
// the outcome bin and a digest of the saved bytes. Two runs (before and after
// a change) compare row by row; no corpus-wide run is implied.
//
//   CHAIN_REPORT=<report.json> CHAIN_OUT=<dir> bun scripts/pdf-corpus/retypesetChainProbe.ts
//   CHAIN_BINS=pushed,failure,tighten-frame,fit-envelope (default: all four)
//   CHAIN_AUDIT=1 saves every chain-push row and runs the official native
//   sample oracle on it.
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {PDFDict,PDFDocument,PDFName} from 'pdf-lib';
import {inspectRunPage} from '../../src/pdf/export/contentStreamEdit/replaceRunPage';
import {exportPdf} from '../../src/pdf/export/exportPdf';
import type {ContentTextOutcome} from '../../src/pdf/export/contentText/outcomes';
import type {PageModel} from '../../src/pdf/model/types';
import {openPdfium} from '../pdf-inplace/nativePdfium';
import {buildCorpusOverlays} from './overlays';
import {cacheDir} from './fetch';
import {auditCorpusSample} from './oracle';
import type {CorpusRow} from './report';
import {retypesetChainShadow,sameRetypesetPush} from '../../src/pdf/export/contentText/retypesetChain';

export function retypesetBin(o:ContentTextOutcome|undefined){
 const m=o?.retypeset;if(!m)return 'other';
 if(m.fitStrategy==='chain-push')return 'chain-push';
 if(m.pushed)return 'pushed';
 if(m.fitStrategy)return m.fitStrategy;
 return m.overflowInkOverlap?'failure':'clear';
}
const input=resolve(process.env.CHAIN_REPORT??'test-artifacts/pdf-corpus/report.json');
const out=resolve(process.env.CHAIN_OUT??'test-artifacts/pdf-corpus/chain-replay');await mkdir(out,{recursive:true});
const bins=new Set((process.env.CHAIN_BINS??'pushed,failure,tighten-frame,fit-envelope').split(','));
const report=JSON.parse(await readFile(input,'utf8')) as {rows:CorpusRow[]};
const selected=report.rows.filter(r=>r.category!=='vertical'&&r.kind!=='overflow-unbreakable'&&bins.has(retypesetBin(r.outcome)));
const sc=new Uint8Array(await readFile('src/assets/fonts/NotoSansSC-Regular.otf')),jp=new Uint8Array(await readFile('src/assets/fonts/NotoSansJP-Regular.otf'));
const native=openPdfium(resolve('vendor/pdfium/linux-x64/lib/libpdfium.so'));
const pages=new Map<string,{before:Uint8Array;page:PageModel;overlays:ReturnType<typeof buildCorpusOverlays>}>();
const rows:{name:string;bin:string;was:string;reason?:string;delta?:number;regions?:unknown[];digest?:string;error?:string;shadow?:Shadow}[]=[];
type Shadow={existingPushed:boolean;same:boolean;chainPushed:boolean;chainReason?:string;chainOverlap:boolean};
// Saved files carry save-time metadata; the page's decoded content stream and
// its resource dictionary are the output that must stay identical.
async function pageDigest(bytes:Uint8Array){
 const doc=await PDFDocument.load(bytes,{ignoreEncryption:true}),page=doc.getPage(0),content=inspectRunPage(page);
 const fonts=page.node.Resources()?.lookupMaybe(PDFName.of('Font'),PDFDict);
 return createHash('sha256').update(content.ok?content.bytes:new TextEncoder().encode(content.reason)).update(String(fonts?.keys().map(k=>k.toString()).sort())).digest('hex').slice(0,16);
}
const audits:unknown[]=[];
let cachedId='',cachedPdf:PDFDocument|undefined;
try{
 for(const row of selected){
  const name=`${row.id}-${row.page}-${row.kind}`,key=`${row.id}-${row.page}`;
  let source=pages.get(key);
  if(!source){
   if(cachedId!==row.id){cachedPdf=await PDFDocument.load(await readFile(join(cacheDir,`${row.id}.pdf`)),{ignoreEncryption:true});cachedId=row.id;}
   const doc=await PDFDocument.create(),[copy]=await doc.copyPages(cachedPdf!,[row.page]),target=doc.addPage(copy!),before=await doc.save();
   const crop=target.getCropBox(),page:PageModel={id:'corpus-page',sourceIndex:0,widthPt:crop.width,heightPt:crop.height,originXPt:crop.x,originYPt:crop.y,rotation:target.getRotation().angle as PageModel['rotation']};
   source={before,page,overlays:buildCorpusOverlays(native.inspectPage(before),page,{vertical:false})};pages.set(key,source);
  }
  const overlay=source.overlays.find(o=>o.originalText===row.original);
  if(!overlay){rows.push({name,bin:'missing',was:retypesetBin(row.outcome)});continue;}
  const shadow:Shadow[]=[];
  retypesetChainShadow.observe=(existing,chain)=>shadow.push({existingPushed:existing.pushed,same:sameRetypesetPush(existing,chain),chainPushed:chain.pushed,chainReason:chain.pushReason,chainOverlap:chain.overflowInkOverlap});
  try{
   const result=await exportPdf(source.before,{pages:[source.page],overlays:[{...overlay,text:row.text}]},{mode:'flatten',stage5Type1:{sourceReuse:true},stage5Reflow:true,stage5Substitute:true,unicodeFontBytes:sc,unicodeJpFontBytes:jp,
    inPlaceFallback:{loadFont:n=>readFile(n.startsWith('Noto')?`src/assets/fonts/${n}`:`node_modules/@docx-editor.dev/fonts/assets/${n}`)}});
   const outcome=result.contentTextOutcomes![0]!;
   if(process.env.CHAIN_AUDIT==='1'&&outcome.retypeset?.fitStrategy==='chain-push'){
    const edit={...overlay,text:row.text};
    await writeFile(join(out,`${name}.before.pdf`),source.before);await writeFile(join(out,`${name}.after.pdf`),result.bytes);
    await writeFile(join(out,`${name}.edit.json`),JSON.stringify({page:source.page,overlay:edit,outcome},null,2));
    try{audits.push({name,...await auditCorpusSample(native,name,out,edit,{sourceReuse:true},true,undefined,outcome)});}
    catch(error){audits.push({name,passed:false,error:String(error)});}
   }
   rows.push({name,bin:retypesetBin(outcome),was:retypesetBin(row.outcome),reason:outcome.retypeset?.pushReason,delta:outcome.retypeset?.pushedDeltaPt,regions:outcome.retypeset?.pushedRegions.map(r=>r.before),digest:await pageDigest(result.bytes),...(shadow.length?{shadow:shadow[0]}:{})});
  }catch(error){rows.push({name,bin:'error',was:retypesetBin(row.outcome),error:String(error)});}
  const last=rows.at(-1)!;console.log(last.name,last.was,'->',last.bin,last.reason??'',last.digest??last.error??'');
 }
}finally{native.close();}
const counts:Record<string,number>={};for(const r of rows){const k=`${r.was}->${r.bin}`;counts[k]=(counts[k]??0)+1;}
// Shadow: every existing push re-planned under the chain rules must be the
// same push. Failure rows the chain declines but finds clear without a move
// are counted only; the contract keeps their existing outcome.
const observed=rows.filter(r=>r.shadow?.existingPushed),shadow={observed:observed.length,identical:observed.filter(r=>r.shadow!.same).length,different:observed.filter(r=>!r.shadow!.same).map(r=>({name:r.name,...r.shadow})),
 clearWithoutMove:rows.filter(r=>r.shadow&&!r.shadow.existingPushed&&!r.shadow.chainPushed&&!r.shadow.chainOverlap).map(r=>r.name)};
await writeFile(join(out,'report.json'),JSON.stringify({command:'bun scripts/pdf-corpus/retypesetChainProbe.ts',input,counts,shadow,audits,rows},null,2));
console.log(counts,shadow,audits);
