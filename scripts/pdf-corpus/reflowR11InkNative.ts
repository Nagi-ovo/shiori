// Four exact saved r17 edits only. Inputs remain read-only; no corpus run.
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {PDFDocument,PDFDict,PDFName} from 'pdf-lib';
import {openPdfium} from '../pdf-inplace/nativePdfium';
import {compareReflowNativePages} from './reflowOracle';
import {exportPdf} from '../../src/pdf/export/exportPdf';
import {inspectRunPage,runPageEnvironment} from '../../src/pdf/export/contentStreamEdit/replaceRunPage';
import {substituteSourceFonts} from '../../src/pdf/export/contentStreamEdit/substituteSource';
import {planSubstitution} from '../../src/pdf/export/contentStreamEdit/substitutePlan';
import {substituteInk} from '../../src/pdf/export/contentStreamEdit/substituteInk';
import {prepareFallback} from '../../src/pdf/export/contentStreamEdit/fallbackFont';
import {fallbackClusters} from '../../src/pdf/export/contentStreamEdit/fallbackClusters';
import {planStreamReflow} from '../../src/pdf/export/contentText/reflowAuto';
import {compileReflowPlan} from '../../src/pdf/export/contentText/reflowCompile';
import {reflowManifest} from '../../src/pdf/export/contentText/reflowManifest';
import {tokenizeContentStream} from '../../src/pdf/export/contentStreamEdit/tokenizer';
import {walkTextPlacements} from '../../src/pdf/export/contentStreamEdit/textState';
import type {PageModel,ContentTextOverlay} from '../../src/pdf/model/types';

const samples=process.argv[2],label=process.argv[3]??'after';
assert(samples,'Usage: bun scripts/pdf-corpus/reflowR11InkNative.ts <r17 samples directory> [label]');
const directory=`test-artifacts/r11-ink/${label}`;
const command=`PDFIUM_LIBRARY=${process.env.PDFIUM_LIBRARY??'vendor/pdfium/linux-x64/lib/libpdfium.so'} bun scripts/pdf-corpus/reflowR11InkNative.ts ${samples} ${label}`;
const names=['arxiv-2611.17107-0-same-length','arxiv-2611.17280-0-longer',
 'arxiv-2611.17320-0-missing-glyph','arxiv-2611.17332-17-same-length'];
await mkdir(directory,{recursive:true});
await writeFile(`${directory}/README.md`,`Regenerate from repo root: ${command}\nFour saved r17 edits, native PDFium at 144 dpi. Explicitly exercise the production substituted/fixed planner and compiler, even when corrected bounds let normal export use a simpler route. Audit the saved r17 after-PDFs and normal exports against the same proved recipe as well. Every audit uses compareReflowNativePages, including its strict raster veto. No masks or oldInk are supplied by this runner.\n`);
const native=openPdfium(process.env.PDFIUM_LIBRARY??'vendor/pdfium/linux-x64/lib/libpdfium.so');
const unicodeFontBytes=new Uint8Array(await readFile('src/assets/fonts/NotoSansSC-Regular.otf'));
const unicodeJpFontBytes=new Uint8Array(await readFile('src/assets/fonts/NotoSansJP-Regular.otf'));
const loadFont=(name:string)=>readFile(name.startsWith('Noto')?`src/assets/fonts/${name}`:`node_modules/@docx-editor.dev/fonts/assets/${name}`);
async function fixedSubstitution(before:Uint8Array,overlay:ContentTextOverlay){
 const doc=await PDFDocument.load(before),page=doc.getPage(0),source=inspectRunPage(page);assert(source.ok);
 const fonts=substituteSourceFonts(page),env=runPageEnvironment(page);
 const selection=planSubstitution(source.bytes,fonts,overlay,env,substituteInk(page,fonts),true);
 const name=selection.lines[0]!.fontName;assert(selection.lines.every(l=>l.fontName===name));
 const dict=page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict);
 let index=1;while(dict.has(PDFName.of(`ShioriSub${index}`)))index++;
 const resource=`ShioriSub${index}`,prepared=await prepareFallback(doc,resource,name,
  [...new Set(selection.lines.flatMap(l=>fallbackClusters(l.text)))],{loadFont});
 dict.set(PDFName.of(resource),prepared.ref);
 const measured=[...fonts,prepared.resolved];
 const plan=planStreamReflow(page,source.bytes,measured,overlay,{...env,stage5Reflow:true},{sourceReuse:true},prepared.resolved);
 assert(plan?.reflow?.substituted,'production substituted recipe refused');assert.equal(plan.reflow.layout.strategy,'fixed');
 const compiled=compileReflowPlan(source.bytes,measured,plan);assert(compiled.ok,compiled.ok?'':compiled.reason);
 const walk=walkTextPlacements(tokenizeContentStream(source.bytes),{resolveFont:name=>{
  const f=measured.find(f=>f.resourceName===name);return f?{...f,ok:true,appliesWordSpacing:f.bytesPerCode===1}:{ok:false,reason:'unmeasurable font'};
 },extGStateSetsFont:name=>env.extGStates?.get(name)?.setsFont??null});assert(walk.ok);
 const manifest=reflowManifest(plan.reflow,walk.glyphs,measured);
 page.node.set(PDFName.of('Contents'),doc.context.register(doc.context.flateStream(compiled.bytes)));
 return {bytes:await doc.save(),manifest};
}
const reports=[];
try{
 for(const name of names){
  const before=await readFile(`${samples}/${name}.before.pdf`);
  const edit=JSON.parse(await readFile(`${samples}/${name}.edit.json`,'utf8')) as {page:PageModel;overlay:ContentTextOverlay};
  const result=await exportPdf(before,{pages:[edit.page],overlays:[edit.overlay]},
   {mode:'flatten',stage5Type1:{sourceReuse:true},stage5Reflow:true,stage5Substitute:true,unicodeFontBytes,unicodeJpFontBytes,
    inPlaceFallback:{loadFont}});
  const outcome=result.contentTextOutcomes?.[0];
  await writeFile(`${directory}/${name}.before.pdf`,before);
  await writeFile(`${directory}/${name}.export.pdf`,result.bytes);
  let oracle,savedSampleOracle,exportOracle,error;
  try{
   const fixed=await fixedSubstitution(before,edit.overlay);
   await writeFile(`${directory}/${name}.after.pdf`,fixed.bytes);
   await writeFile(`${directory}/${name}.edit.json`,JSON.stringify({...edit,outcome,manifest:fixed.manifest},null,2));
   const original=native.inspectPage(before,0,true);
   oracle=compareReflowNativePages(original,native.inspectPage(fixed.bytes,0,true),edit.overlay,fixed.manifest);
   assert(oracle.changedPixels>0);assert.equal(oracle.changedPixelsOutsideMask,0);assert.equal(oracle.unexplainedOriginalPixels,0);
   savedSampleOracle=compareReflowNativePages(original,native.inspectPage(await readFile(`${samples}/${name}.after.pdf`),0,true),edit.overlay,fixed.manifest);
   assert(outcome&&outcome.mode!=='overlay','normal export refused');
   const saved=native.inspectPage(result.bytes,0,true);
   exportOracle=compareReflowNativePages(original,saved,edit.overlay,outcome.reflow??fixed.manifest);
  }catch(cause){error=String(cause);process.exitCode=1;}
  const report={name,mode:'substituted',strategy:'fixed',exportMode:outcome?.mode,exportStrategy:outcome?.reflow?.strategy,passed:!error,oracle,savedSampleOracle,exportOracle,error};
  reports.push(report);console.log(JSON.stringify(report));
 }
}finally{
 native.close();await writeFile(`${directory}/report.json`,JSON.stringify({command,passed:reports.length===4&&reports.every(r=>r.passed),reports},null,2));
}
