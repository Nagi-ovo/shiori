// Seven exact r10 edits only; never writes to the corpus cache or snapshots.
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {PDFDocument} from 'pdf-lib';
import {openPdfium} from '../pdf-inplace/nativePdfium';
import {buildCorpusOverlays} from './overlays';
import {compareReflowNativePages} from './reflowOracle';
import {exportPdf} from '../../src/pdf/export/exportPdf';
import {inspectRunPage,resolveRunFonts} from '../../src/pdf/export/contentStreamEdit/replaceRunPage';
import {substituteSourceFonts} from '../../src/pdf/export/contentStreamEdit/substituteSource';
import {tokenizeContentStream} from '../../src/pdf/export/contentStreamEdit/tokenizer';
import {walkTextPlacements} from '../../src/pdf/export/contentStreamEdit/textState';
import {removalsByRect} from '../../src/pdf/export/contentStreamEdit/removeGlyphs';
import {streamReflowEvidence} from '../../src/pdf/export/contentText/reflowEvidence';
import type {CorpusRow} from './report';
import type {PageModel} from '../../src/pdf/model/types';
import type {AppliedReflowManifest} from '../../src/pdf/export/contentText/reflowManifest';

const label=process.argv[2]??'after',directory=`test-artifacts/reflow-r11-restore/${label}`;
const command=`bun scripts/pdf-corpus/reflowR11RestoreNative.ts ${label}`;
await mkdir(directory,{recursive:true});
await writeFile(`${directory}/README.md`,`Regenerate from repo root: ${command}\nUses the r10 report's seven exact edits and the three cached PDFs. Native PDFium at 144 dpi. No full corpus run.\n`);
const baseline=JSON.parse(await readFile('test-artifacts/pdf-corpus-r10/report.json','utf8')) as {rows:CorpusRow[]};
const rows=baseline.rows.filter(r=>r.id==='gsa-1'&&r.page===4&&['same-length','longer'].includes(r.kind)||
 r.id==='gsa-2'&&r.page===5&&['same-length','missing-glyph','longer','multi-line'].includes(r.kind)||
 r.id==='zh-d2l-pytorch'&&r.page===597&&r.kind==='overflow');
assert.equal(rows.length,7);
const native=openPdfium(process.env.PDFIUM_LIBRARY??'vendor/pdfium/linux-x64/lib/libpdfium.so');
const sc=new Uint8Array(await readFile('src/assets/fonts/NotoSansSC-Regular.otf'));
const jp=new Uint8Array(await readFile('src/assets/fonts/NotoSansJP-Regular.otf'));
const reports:unknown[]=[];
let accepted=0,audited=0,completed=false;
function rasterAudit(before:ReturnType<typeof native.inspectPage>,after:ReturnType<typeof native.inspectPage>,manifest:AppliedReflowManifest){
 assert(before.pixels&&after.pixels);assert.equal(before.pixels.length,after.pixels.length);
 const width=Math.round(before.width*2),height=Math.round(before.height*2),box=manifest.region.box,mask=manifest.region.mask??[box];
 let changedPixels=0,changedPixelsOutsideBox=0,changedPixelsOutsideMask=0;
 for(let p=0;p<before.pixels.length;p+=4)if(!before.pixels.subarray(p,p+4).every((v,i)=>v===after.pixels![p+i])){
  changedPixels++;const at=p/4,x=(at%width+.5)/2,y=(height-Math.floor(at/width)-.5)/2;
  if(x<box.x||x>box.x+box.w||y<box.y||y>box.y+box.h)changedPixelsOutsideBox++;
  if(!mask.some(b=>x>=b.x&&x<=b.x+b.w&&y>=b.y&&y<=b.y+b.h))changedPixelsOutsideMask++;
 }
 assert(changedPixels>0);assert.equal(changedPixelsOutsideBox,0);assert.equal(changedPixelsOutsideMask,0);
 return {changedPixels,changedPixelsOutsideBox,changedPixelsOutsideMask};
}
try{
 for(const row of rows){
  const pdf=await PDFDocument.load(await readFile(`test-artifacts/pdf-corpus/cache/${row.id}.pdf`));
  const single=await PDFDocument.create(),[copy]=await single.copyPages(pdf,[row.page]),target=single.addPage(copy!);
  const before=await single.save(),geometry=native.inspectPage(before),crop=target.getCropBox();
  const page:PageModel={id:'corpus-page',sourceIndex:0,widthPt:crop.width,heightPt:crop.height,originXPt:crop.x,originYPt:crop.y,rotation:target.getRotation().angle as PageModel['rotation']};
  const overlay=buildCorpusOverlays(geometry,page).find(o=>o.originalText===row.original);assert(overlay,'r10 selection missing');
  const edit={...overlay,text:row.text},name=`${row.id}-${row.page}-${row.kind}`;
  const source=inspectRunPage(target);assert(source.ok);
  const evidence=(substitute:boolean)=>{
   const fonts=substitute?substituteSourceFonts(target):resolveRunFonts(target,{sourceReuse:true});
   const walk=walkTextPlacements(tokenizeContentStream(source.bytes),{resolveFont:name=>{
    const f=fonts.find(f=>f.resourceName===name);return f?{...f,ok:true,appliesWordSpacing:f.bytesPerCode===1}:null;
   }});assert(walk.ok);
   const selected=[...new Set(removalsByRect(walk.glyphs,edit.coverRects).flatMap(h=>[...h]))];assert(selected.length);
   const e=streamReflowEvidence(target,source.bytes,fonts,selected[0]!.opIndex,{sourceReuse:true},substitute);
   return e.ok?{ok:true,slots:e.proof.lineSlots,group:{start:e.visualGroup.start,end:e.visualGroup.end,column:e.visualGroup.column}}:e;
  };
  const result=await exportPdf(before,{pages:[page],overlays:[edit]},{mode:'flatten',stage5Type1:{sourceReuse:true},stage5Reflow:true,stage5Substitute:true,unicodeFontBytes:sc,unicodeJpFontBytes:jp,
   inPlaceFallback:{loadFont:name=>readFile(name.startsWith('Noto')?`src/assets/fonts/${name}`:`node_modules/@docx-editor.dev/fonts/assets/${name}`)}});
  const outcome=result.contentTextOutcomes?.[0];assert(outcome);
  if(outcome.mode!=='overlay')accepted++;
  await writeFile(`${directory}/${name}.before.pdf`,before);await writeFile(`${directory}/${name}.after.pdf`,result.bytes);
  await writeFile(`${directory}/${name}.edit.json`,JSON.stringify({page,overlay:edit,row:{...row,outcome},stage5Type1:{sourceReuse:true},stage5Reflow:true,stage5Substitute:true},null,2));
  let raster,oracle,oracleError;
  if(outcome.reflow){
   const original=native.inspectPage(before,0,true),saved=native.inspectPage(result.bytes,0,true);
   raster=rasterAudit(original,saved,outcome.reflow);
   try{oracle=compareReflowNativePages(original,saved,edit,outcome.reflow);audited++;}catch(error){
    oracleError=String(error);
    process.exitCode=1;
   }
  }
  const report={name,expected:{mode:row.outcome.mode,strategy:row.outcome.reflow?.strategy},mode:outcome.mode,strategy:outcome.reflow?.strategy,reason:outcome.reason,detail:outcome.detail,
   sourceEvidence:evidence(false),substitutionEvidence:evidence(true),raster,oracle,oracleError};reports.push(report);
  console.log(JSON.stringify(report));
  if(label!=='before'){
   assert.equal(outcome.mode,row.outcome.mode,name);assert.equal(outcome.reflow?.strategy,row.outcome.reflow?.strategy,name);
  }
 }
 completed=true;
}finally{
 native.close();await writeFile(`${directory}/report.json`,JSON.stringify({command,passed:completed&&(label==='before'||audited===7),accepted,audited,reports},null,2));
}
