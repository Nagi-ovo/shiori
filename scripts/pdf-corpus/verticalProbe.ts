// Per-file vertical probe; ORACLE=all audits every success, MULTI=1 includes
// the selected multiline test case. Never invokes the full corpus.
import {PDFDocument} from 'pdf-lib';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {openPdfium} from '../pdf-inplace/nativePdfium';
import {fetchEntry,readManifest,samplePages} from './fetch';
import {buildCorpusOverlays} from './overlays';
import {editMatrix} from './editMatrix';
import {exportPdf} from '../../src/pdf/export/exportPdf';
import type {PageModel} from '../../src/pdf/model/types';
import {auditCorpusSample} from './oracle';
import {mkdir,writeFile} from 'node:fs/promises';
const odir=process.env.ODIR??'test-artifacts/r26-vert/probe';await mkdir(odir,{recursive:true});const audited=new Set<string>();
const native=openPdfium(resolve('vendor/pdfium/linux-x64/lib','libpdfium.so'));
const only=process.argv[2];
const entries=(await readManifest()).filter(e=>e.category==='vertical'&&(!only||e.id.includes(only)));
const sc=new Uint8Array(await readFile('src/assets/fonts/NotoSansSC-Regular.otf')),jp=new Uint8Array(await readFile('src/assets/fonts/NotoSansJP-Regular.otf'));
let ok=0,total=0,oracleFailures=0;
const rows:{id:string;page:number;kind:string;outcome:unknown;oracle?:unknown}[]=[];
for(const entry of entries){
 const bytes=await fetchEntry(entry),pdf=await PDFDocument.load(bytes,{ignoreEncryption:true});
 const hist=new Map<string,number>();let fok=0,ft=0;
 for(const pageIndex of samplePages(pdf.getPageCount()).slice(0,Number(process.env.PAGES??5))){
  const single=await PDFDocument.create();const [copied]=await single.copyPages(pdf,[pageIndex]);const target=single.addPage(copied!);
  const before=await single.save(),geometry=native.inspectPage(before),crop=target.getCropBox();
  const page:PageModel={id:'corpus-page',sourceIndex:0,widthPt:crop.width,heightPt:crop.height,originXPt:crop.x,originYPt:crop.y,rotation:target.getRotation().angle as PageModel['rotation']};
  const overlays=buildCorpusOverlays(geometry,page,{vertical:true});
  const one=overlays.find(o=>!o.originalText.includes('\n')&&/\p{Script=Han}/u.test(o.originalText));
  if(!one)continue;
  if(process.env.SHOW)console.log(pageIndex,JSON.stringify(one.originalText),one.coverRects.length);
  const cases=editMatrix(one.originalText).map(e=>({kind:e.kind,overlay:{...one,text:e.text}}));
  const multi=overlays.find(o=>o.originalText.includes('\n'));
  if(process.env.MULTI==='1'&&multi){const first=editMatrix(multi.originalText.split('\n')[0]!)[0];if(first)cases.push({kind:'multi-line',overlay:{...multi,text:first.text+'\n'+multi.originalText.split('\n').slice(1).join('\n')}});}
  for(const e of cases){
   const r=await exportPdf(before,{pages:[page],overlays:[e.overlay]},{mode:'flatten',stage5Type1:{sourceReuse:true},stage5Reflow:true,stage5Substitute:true,unicodeFontBytes:sc,unicodeJpFontBytes:jp,inPlaceFallback:{loadFont:name=>readFile(name.startsWith('Noto')?`src/assets/fonts/${name}`:`node_modules/@docx-editor.dev/fonts/assets/${name}`)}});
   const o=r.contentTextOutcomes![0]!;ft++;total++;
   const row:typeof rows[number]={id:entry.id,page:pageIndex,kind:e.kind,outcome:o};rows.push(row);
   if(o.mode!=='unsupported'){fok++;ok++;
    const okey=`${entry.id}-${pageIndex}-${e.kind}`;
    if(process.env.ORACLE&&(process.env.ORACLE==='all'||!audited.has(entry.id))&&!audited.has(okey)){audited.add(entry.id);audited.add(okey);
     const name=`${entry.id}-${pageIndex}-${e.kind}`,overlay=e.overlay;
     await writeFile(`${odir}/${name}.before.pdf`,before);await writeFile(`${odir}/${name}.after.pdf`,r.bytes);
     try{row.oracle=await auditCorpusSample(native,name,odir,overlay,{sourceReuse:true},true,undefined,o);console.log('  ORACLE PASS',name);}catch(err){oracleFailures++;row.oracle={passed:false,error:String(err)};console.log('  ORACLE FAIL',name,String(err).slice(0,300));}
    }}
   const key=o.mode==="unsupported"?`${o.reason}: ${String(o.detail??"").slice(0,Number(process.env.DETAIL??110))}`:o.mode;
   hist.set(key,(hist.get(key)??0)+1);
   if(process.env.SHOW)console.log('  ',e.kind,JSON.stringify(e.overlay.text).slice(0,40),key);
  }
 }
 console.log(`${entry.id}: ${fok}/${ft}`);for(const [k,v]of [...hist].sort((a,b)=>b[1]-a[1]))console.log(`   ${v} ${k}`);
}
console.log(`TOTAL ${ok}/${total}; oracle failures ${oracleFailures}`);native.close();
await writeFile(`${odir}/${only??'vertical'}.results.json`,JSON.stringify({command:process.argv.join(' '),options:{ORACLE:process.env.ORACLE,MULTI:process.env.MULTI,PAGES:process.env.PAGES},ok,total,oracleFailures,rows},null,2));
if(oracleFailures)process.exitCode=1;
