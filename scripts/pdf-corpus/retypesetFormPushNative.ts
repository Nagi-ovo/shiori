// Bounded saved-r22 reproduction: no downloads and no corpus/cache writes.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import type {ContentTextOverlay,PageModel} from '../../src/pdf/model/types';
import {exportPdf} from '../../src/pdf/export/exportPdf';
import {openPdfium} from '../pdf-inplace/nativePdfium';
import {editMatrix} from './editMatrix';
import {auditCorpusSample} from './oracle';
import {compareRetypesetNativePages} from './retypesetOracle';
import {retypesetSourceOwnership} from './retypesetStreamOracle';

const sample=process.env.R23_FORM_SAMPLE??'test-artifacts/pdf-corpus-r22/samples/arxiv-2611.17052-22-same-length';
const label=process.argv[2]??'after',directory=resolve(`test-artifacts/r23-form/${label}`);
const command=`bun scripts/pdf-corpus/retypesetFormPushNative.ts ${label}`;
const before=await readFile(`${sample}.before.pdf`),metadata=JSON.parse(await readFile(`${sample}.edit.json`,'utf8')) as {page:PageModel;overlay:ContentTextOverlay};
await mkdir(directory,{recursive:true});await writeFile(`${directory}/README.md`,`Regenerate: ${command}\nSource (read only): ${sample}\nPage index 22; four formerly form-context-blocked variants only.\n`);
const native=openPdfium(resolve('vendor/pdfium/linux-x64/lib/libpdfium.so')),rows=[];
try{
 for(const variant of editMatrix(metadata.overlay.originalText).filter(e=>['same-length','longer','overflow','overflow-2'].includes(e.kind))){
  const name=`arxiv-2611.17052-22-${variant.kind}`,edit={...metadata.overlay,text:variant.text};
  const result=await exportPdf(before,{pages:[metadata.page],overlays:[edit]},{mode:'flatten',stage5Type1:{sourceReuse:true},stage5Reflow:true,stage5Substitute:true,
   inPlaceFallback:{loadFont:name=>readFile(name.startsWith('Noto')?`src/assets/fonts/${name}`:`node_modules/@docx-editor.dev/fonts/assets/${name}`)}});
  const outcome=result.contentTextOutcomes![0]!;
  await writeFile(`${directory}/${name}.before.pdf`,before);await writeFile(`${directory}/${name}.after.pdf`,result.bytes);
  await writeFile(`${directory}/${name}.edit.json`,JSON.stringify({page:metadata.page,edit,outcome},null,2));
  let nativeEvidence:unknown,oracle:unknown;
  try{
   const a=native.inspectPage(before,0,true),b=native.inspectPage(result.bytes,0,true),doc=await PDFDocument.load(before);
   nativeEvidence=compareRetypesetNativePages(a,b,edit,outcome.retypeset,retypesetSourceOwnership(doc.getPage(0),a.glyphs,edit,{sourceReuse:true}));
   // Keep the saved evidence small; full glyph objects are re-openable PDFs.
   nativeEvidence={...nativeEvidence as ReturnType<typeof compareRetypesetNativePages>,ownedSourceGlyphs:undefined};
  }catch(error){nativeEvidence={passed:false,error:String(error)};}
  try{oracle=await auditCorpusSample(native,name,directory,edit,{sourceReuse:true},true,undefined,outcome);}catch(error){oracle={passed:false,error:String(error)};}
  const row={kind:variant.kind,outcome,nativeEvidence,oracle};rows.push(row);console.log(JSON.stringify({kind:variant.kind,manifest:outcome.retypeset,nativeEvidence,oracle:oracle&&typeof oracle==='object'&&'passed' in oracle?oracle.passed:oracle}));
 }
}finally{native.close();await writeFile(`${directory}/report.json`,JSON.stringify({command,rows},null,2));}
