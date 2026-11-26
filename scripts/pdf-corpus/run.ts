// Type1 reuse defaults on; SHIORI_STAGE5_TYPE1_SOURCE_REUSE=0 forces legacy off.
// Standard-14 AFM remains disabled pending its native gate.
import {PDFDocument} from 'pdf-lib';
import {readFile,mkdir,writeFile,readdir,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {openPdfium} from '../pdf-inplace/nativePdfium';
import {fetchEntry,readManifest,samplePages} from './fetch';
import {buildCorpusOverlays} from './overlays';
import {missingHanEdit} from './missingHan';
import {inspectRunPage,resolveRunFonts} from '../../src/pdf/export/contentStreamEdit/replaceRunPage';
import {editMatrix} from './editMatrix';
import {auditCorpusSample} from './oracle';
import {oracleVerdicts} from './oracleVerdict';
import {selectOracleSamples} from './selectOracleSamples';
import {shouldSaveCorpusSample} from './saveSamples';
import {corpusReportOutcome} from './annotationProvenance';
import {markdownReport,summarize,summarizeReport,type CorpusRow} from './report';
import {exportPdf} from '../../src/pdf/export/exportPdf';
import type {PageModel} from '../../src/pdf/model/types';
const stage5Type1={sourceReuse:process.env.SHIORI_STAGE5_TYPE1_SOURCE_REUSE!=='0'};
const stage5Substitute=process.env.SHIORI_STAGE5_SUBSTITUTE!=='0';
const stage5Reflow=process.env.SHIORI_STAGE5_REFLOW!=='0';
const started=performance.now(),out=resolve(process.env.CORPUS_OUT??'test-artifacts/pdf-corpus');await rm(join(out,'samples'),{recursive:true,force:true});await mkdir(join(out,'samples'),{recursive:true});
const native=openPdfium(resolve(process.env.SHIORI_PDFIUM_DIR??'vendor/pdfium/linux-x64/lib','libpdfium.so'));
const allEntries=await readManifest(),entries=process.env.CORPUS_CATEGORY?allEntries.filter(e=>e.category===process.env.CORPUS_CATEGORY):allEntries,limit=Number(process.env.CORPUS_LIMIT??entries.length),pageLimit=Number(process.env.CORPUS_PAGES??5);
const rows:CorpusRow[]=[],skips:unknown[]=[],oracle:unknown[]=[];
const sc=new Uint8Array(await readFile('src/assets/fonts/NotoSansSC-Regular.otf')),jp=new Uint8Array(await readFile('src/assets/fonts/NotoSansJP-Regular.otf'));
try{
 for(const entry of entries.slice(0,limit)){
  const bytes=await fetchEntry(entry),pdf=await PDFDocument.load(bytes,{ignoreEncryption:true});
  for(const pageIndex of samplePages(pdf.getPageCount()).slice(0,pageLimit)){
   const originalPage=pdf.getPage(pageIndex);
   const single=await PDFDocument.create();const [copied]=await single.copyPages(pdf,[pageIndex]);const target=single.addPage(copied!);
   const before=await single.save(),geometry=native.inspectPage(before),crop=target.getCropBox();
   const page:PageModel={id:'corpus-page',sourceIndex:0,widthPt:crop.width,heightPt:crop.height,originXPt:crop.x,originYPt:crop.y,rotation:target.getRotation().angle as PageModel['rotation']};
   const overlays=buildCorpusOverlays(geometry,page,{vertical:entry.category==='vertical'});
   const preferHan=entry.category==='chinese'||entry.category==='vertical';
   const one=overlays.find(o=>!o.originalText.includes('\n') && (!preferHan || /\p{Script=Han}/u.test(o.originalText)));
   const multi=overlays.find(o=>o.originalText.includes('\n'));
   if(!one){skips.push({id:entry.id,page:pageIndex,reason:'no-high-confidence-line'});continue;}
   const cases=editMatrix(one.originalText).map(e=>({edit:{...one,text:e.text},kind:e.kind}));
   if(entry.category==='chinese'){
    const content=inspectRunPage(target);
    const missing=content.ok?missingHanEdit(content.bytes,resolveRunFonts(target,stage5Type1),one):null;
    if(missing)cases.push({edit:{...one,text:missing.text},kind:missing.kind});
    else skips.push({id:entry.id,page:pageIndex,reason:'no-provable-missing-han-target'});
   }
   if(multi){const first=editMatrix(multi.originalText.split('\n')[0]!)[0];if(first)cases.push({edit:{...multi,text:first.text+'\n'+multi.originalText.split('\n').slice(1).join('\n')},kind:'multi-line'});}
   else skips.push({id:entry.id,page:pageIndex,reason:'no-high-confidence-multiline'});
   for(const c of cases){
    const start=performance.now();
    try{
     const fallbackFonts:string[]=[];
     const result=await exportPdf(before,{pages:[page],overlays:[c.edit]},{mode:'flatten',stage5Type1,stage5Reflow,stage5Substitute,unicodeFontBytes:sc,unicodeJpFontBytes:jp,
      inPlaceFallback:{loadFont:name=>{fallbackFonts.push(name);return readFile(name.startsWith('Noto')?`src/assets/fonts/${name}`:`node_modules/@docx-editor.dev/fonts/assets/${name}`);}}});
     const outcome=result.contentTextOutcomes?.[0];if(!outcome)throw Error('missing production overlay outcome');
     const sampleRow:CorpusRow={id:entry.id,category:entry.category,page:pageIndex,kind:c.kind,original:c.edit.originalText,text:c.edit.text,ms:performance.now()-start,outcome,...(fallbackFonts.length?{fallbackFonts}: {})};
     const saveSample=shouldSaveCorpusSample(sampleRow,rows);
     rows.push({...sampleRow,outcome:corpusReportOutcome(outcome,originalPage,target)});
     // Preserve independent saved inputs for the native sample pass.
     if(saveSample){
      const name=`${entry.id}-${pageIndex}-${c.kind}`;await writeFile(join(out,'samples',`${name}.before.pdf`),before);await writeFile(join(out,'samples',`${name}.after.pdf`),result.bytes);await writeFile(join(out,'samples',`${name}.edit.json`),JSON.stringify({page,overlay:c.edit,row:sampleRow,stage5Type1,stage5Reflow,stage5Substitute},null,2));
     }
    }catch(error){throw new Error(`Corpus export failed: ${entry.id}/${pageIndex}/${c.kind}`,{cause:error});}
   }
   console.log(entry.id,pageIndex,summarize(rows.filter(r=>r.id===entry.id)));
  }
  const report={stage5Type1,stage5Reflow,stage5Substitute,categories:[...new Set(entries.slice(0,limit).map(e=>e.category))],files:Math.min(limit,entries.length),elapsedMs:performance.now()-started,rows,skips,oracle,...summarizeReport(rows)};
  await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));await writeFile(join(out,'report.md'),markdownReport(report));
 }
 const candidates=[];
 for(const file of (await readdir(join(out,'samples'))).filter(f=>f.endsWith('.edit.json'))){const metadata=JSON.parse(await readFile(join(out,'samples',file),'utf8'));candidates.push({file,metadata});}
 for(const {file,metadata} of selectOracleSamples(candidates)){
  const name=file.replace('.edit.json','');
  try{const checked=await auditCorpusSample(native,name,join(out,'samples'),metadata.overlay,metadata.stage5Type1,metadata.stage5Reflow,metadata.row.outcome.reflow,metadata.row.outcome);oracle.push(checked);console.log('oracle passed',name);}
  catch(error){oracle.push({name,passed:false,...oracleVerdicts(error),error:String(error)});process.exitCode=1;console.error('P0 accepted edit failed native oracle',name,String(error));}
 }
 const report={stage5Type1,stage5Reflow,stage5Substitute,categories:[...new Set(entries.slice(0,limit).map(e=>e.category))],files:Math.min(limit,entries.length),elapsedMs:performance.now()-started,rows,skips,oracle,...summarizeReport(rows)};
 await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));await writeFile(join(out,'report.md'),markdownReport(report));
}finally{native.close();}
console.log('Report:',join(out,'report.md'));
