// Read-only r22 replay: use the saved original PDF/selection, change only the
// replacement text from each report row, and run the full production exporter.
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {exportPdf} from '../../src/pdf/export/exportPdf';
import type {ContentTextOverlay,PageModel} from '../../src/pdf/model/types';
import type {CorpusRow} from './report';
import type {ContentTextOutcome} from '../../src/pdf/export/contentText/outcomes';
import {openPdfium} from '../pdf-inplace/nativePdfium';
import {buildCorpusOverlays} from './overlays';
import {auditCorpusSample} from './oracle';
import {cacheDir} from './fetch';

const input=resolve(process.env.PUSHFIT_R22??'test-artifacts/pdf-corpus-r22');
const output=resolve('test-artifacts/r23-pushfit/replay');await mkdir(output,{recursive:true});
const report=JSON.parse(await readFile(join(input,'report.json'),'utf8')) as {rows:CorpusRow[]};
const files=(await readdir(join(input,'samples'))).filter(f=>f.endsWith('.edit.json'));
const specs=await Promise.all(files.map(async file=>({file,spec:JSON.parse(await readFile(join(input,'samples',file),'utf8')) as {page:PageModel;overlay:ContentTextOverlay;row:CorpusRow;stage5Type1:{sourceReuse:boolean};stage5Reflow:boolean;stage5Substitute:boolean}})));
const eligible=report.rows.filter(row=>row.kind!=='overflow-unbreakable'&&row.outcome.retypeset?.overflowed);
type ReplayRow={name:string;before:ContentTextOutcome;after:ContentTextOutcome};
const auditMissing=process.env.PUSHFIT_AUDIT_MISSING==='1';
const replayPushed=process.env.PUSHFIT_REPLAY_PUSHED==='1';
const prior=process.env.PUSHFIT_RETRY_BLOCKED==='1'||auditMissing||replayPushed?JSON.parse(await readFile(join(output,'report.json'),'utf8')):undefined;
const rows:ReplayRow[]=prior?.rows??[],missing:string[]=prior?.missing??[],oracle:{name:string;passed:boolean;error?:string}[]=prior?.oracle??[];
const selected=prior?eligible.filter(row=>{
 const name=`${row.id}-${row.page}-${row.kind}`,old=rows.find(r=>r.name===name);
 return replayPushed?old?.after.retypeset?.pushed:auditMissing?old?.before.retypeset?.overflowInkOverlap&&old.after.retypeset?.overflowInkOverlap===false&&!oracle.some(a=>a.name===name):old?.after.retypeset?.overflowInkOverlap;
}):eligible;
const sc=new Uint8Array(await readFile('src/assets/fonts/NotoSansSC-Regular.otf')),jp=new Uint8Array(await readFile('src/assets/fonts/NotoSansJP-Regular.otf'));
const native=openPdfium(resolve('vendor/pdfium/linux-x64/lib/libpdfium.so'));
const generated=new Map<string,{before:Uint8Array;page:PageModel;overlays:ContentTextOverlay[]}>();
let cachedId='',cachedPdf:PDFDocument|undefined;
try{
for(const row of selected){
 const name=`${row.id}-${row.page}-${row.kind}`;
 const saved=specs.find(s=>s.spec.row.id===row.id&&s.spec.row.page===row.page&&s.spec.overlay.originalText===row.original);
 let spec=saved?.spec,before:Uint8Array;
 if(saved)before=await readFile(join(input,'samples',saved.file.replace('.edit.json','.before.pdf')));
 else{
  const key=`${row.id}-${row.page}`;let original=generated.get(key);
  if(!original){
   if(cachedId!==row.id){cachedPdf=await PDFDocument.load(await readFile(join(cacheDir,`${row.id}.pdf`)));cachedId=row.id;}
   const doc=await PDFDocument.create(),[copy]=await doc.copyPages(cachedPdf!,[row.page]),target=doc.addPage(copy!);before=await doc.save();
   const crop=target.getCropBox(),page:PageModel={id:'corpus-page',sourceIndex:0,widthPt:crop.width,heightPt:crop.height,originXPt:crop.x,originYPt:crop.y,rotation:target.getRotation().angle as PageModel['rotation']};
   original={before,page,overlays:buildCorpusOverlays(native.inspectPage(before),page)};generated.set(key,original);
  }
  const overlay=original.overlays.find(o=>o.originalText===row.original);
  if(!overlay){missing.push(name);continue;}
  before=original.before;spec={page:original.page,overlay,row,stage5Type1:{sourceReuse:true},stage5Reflow:true,stage5Substitute:true};
 }
 if(!spec)throw Error('missing source spec');
 const overlay={...spec.overlay,text:row.text};
 const result=await exportPdf(before,{pages:[spec.page],overlays:[overlay]},{mode:'flatten',stage5Type1:spec.stage5Type1,stage5Reflow:spec.stage5Reflow,stage5Substitute:spec.stage5Substitute,unicodeFontBytes:sc,unicodeJpFontBytes:jp,
  inPlaceFallback:{loadFont:name=>readFile(name.startsWith('Noto')?`src/assets/fonts/${name}`:`node_modules/@docx-editor.dev/fonts/assets/${name}`)}});
 const outcome=result.contentTextOutcomes![0]!;
 const previousAudit=oracle.findIndex(a=>a.name===name);if(previousAudit>=0)oracle.splice(previousAudit,1);
 const record={name,before:row.outcome,after:outcome},index=rows.findIndex(r=>r.name===name);
 if(index<0)rows.push(record);else rows[index]=record;
 if(outcome.retypeset?.pushed||outcome.retypeset?.frameFit||row.outcome.retypeset?.overflowInkOverlap&&outcome.retypeset?.overflowInkOverlap===false){
  await writeFile(join(output,`${name}.before.pdf`),before);await writeFile(join(output,`${name}.after.pdf`),result.bytes);
  await writeFile(join(output,`${name}.edit.json`),JSON.stringify({page:spec.page,overlay,outcome,stage5Type1:spec.stage5Type1,stage5Reflow:spec.stage5Reflow,stage5Substitute:spec.stage5Substitute},null,2));
  if(process.env.PUSHFIT_AUDIT==='1'&&row.outcome.retypeset?.overflowInkOverlap&&!outcome.retypeset.overflowInkOverlap){
   try{oracle.push(await auditCorpusSample(native,name,output,overlay,spec.stage5Type1,spec.stage5Reflow,undefined,outcome));}
   catch(error){oracle.push({name,passed:false,error:String(error)});}
  }
 }
 console.log(name,outcome.mode,outcome.retypeset?.overflowInkOverlap,outcome.retypeset?.pushReason??outcome.retypeset?.fitStrategy??'clear',outcome.retypeset?.frameFit?.sizeScale??'');
 await writeFile(join(output,'report.json'),JSON.stringify({command:'PUSHFIT_AUDIT=1 bun scripts/pdf-corpus/retypesetPushFitProbe.ts',input,eligible:eligible.length,replayed:rows.length,missing,rows,oracle},null,2));
}
await writeFile(join(output,'report.json'),JSON.stringify({command:'PUSHFIT_AUDIT=1 bun scripts/pdf-corpus/retypesetPushFitProbe.ts',input,eligible:eligible.length,replayed:rows.length,missing,rows,oracle},null,2));
}finally{native.close();}
