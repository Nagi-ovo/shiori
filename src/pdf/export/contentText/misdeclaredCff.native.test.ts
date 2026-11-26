import {expect,test} from 'bun:test';
import {PDFDict,PDFDocument,PDFName} from 'pdf-lib';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {openPdfium} from '../../../../scripts/pdf-inplace/nativePdfium';
import {buildCorpusOverlays} from '../../../../scripts/pdf-corpus/overlays';
import {auditCorpusSample} from '../../../../scripts/pdf-corpus/oracle';
import {exportPdf} from '../exportPdf';
import {fontCoverageFromDict,fontInputFromDict} from '../fontCoverage/pdfLibAdapter';
import {readProgram} from '../fontCoverage/program';

// The licensed cache is opt-in and never copied into source control.
// Before the fix this row fails with unknown-output-ink (corpus-before.log).
const cached=process.env.SHIORI_ZH_OJS_PDF;
test.skipIf(!cached)('zh-ojs-law page 2 overflow has proved CFF ink and passes the unchanged native oracle',async()=>{
 const doc=await PDFDocument.load(await readFile(cached!)),single=await PDFDocument.create();
 const [page]=await single.copyPages(doc,[2]);single.addPage(page!);
 const p=single.getPage(0),crop=p.getCropBox(),before=await single.save();
 const raw=p.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('FT8'),PDFDict),input=fontInputFromDict(raw);
 expect(input).toMatchObject({subtype:'Type0',cidSubtype:'CIDFontType2',programKind:'FontFile2'});
 expect(readProgram(input)).toMatchObject({kind:'fontkit',cff:true,cid:true});
 const native=openPdfium('vendor/pdfium/linux-x64/lib/libpdfium.so');
 try{
  const model={id:'corpus-page',sourceIndex:0,widthPt:crop.width,heightPt:crop.height,originXPt:crop.x,originYPt:crop.y,rotation:0 as const};
  const originalText='东山公司等抄袭并用于生产销售，构成著作权侵权及不正当竞争。而法院在审理时认为，“幻之';
  const source=buildCorpusOverlays(native.inspectPage(before),model).find(o=>o.originalText===originalText);
  expect(source).toBeDefined();
  const edit={...source!,text:originalText+'这种情况需要进一步说明'};
  expect(fontCoverageFromDict(raw).canEncode(originalText).ok).toBe(true);
  const exported=await exportPdf(before,{pages:[model],overlays:[edit]},{mode:'flatten',stage5Type1:{sourceReuse:true},stage5Reflow:true,stage5Substitute:true,
   inPlaceFallback:{loadFont:name=>readFile(name.startsWith('Noto')?`src/assets/fonts/${name}`:`node_modules/@docx-editor.dev/fonts/assets/${name}`)}});
  const outcome=exported.contentTextOutcomes![0]!;
  expect(outcome.mode).toBe('retypeset');expect(outcome.retypeset?.overflowed).toBe(true);
  const out='test-artifacts/r23-ink/real',name='zh-ojs-law-2-overflow';await mkdir(out,{recursive:true});
  await writeFile(`${out}/${name}.before.pdf`,before);await writeFile(`${out}/${name}.after.pdf`,exported.bytes);
  await writeFile(`${out}/${name}.edit.json`,JSON.stringify({overlay:edit,outcome},null,2));
  const oracle=await auditCorpusSample(native,name,out,edit,{sourceReuse:true},true,undefined,outcome);
  expect(oracle.passed).toBe(true);
  await writeFile(`${out}/report.json`,JSON.stringify({command:`SHIORI_ZH_OJS_PDF='${cached!.replaceAll("'", "'\\''")}' bun test src/pdf/export/contentText/misdeclaredCff.native.test.ts`,outcome,oracle},null,2));
 }finally{native.close();}
},60_000);
