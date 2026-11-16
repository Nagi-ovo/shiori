import {expect,test} from 'bun:test';
import {existsSync} from 'node:fs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {PDFArray,PDFDict,PDFDocument,PDFName} from 'pdf-lib';
import {fixture,model,overlay} from '../../src/pdf/export/contentText/fixtures.test-support';
import {exportPdf} from '../../src/pdf/export/exportPdf';
import {openPdfium} from '../pdf-inplace/nativePdfium';
import {auditCorpusSample,compareNativePages} from './oracle';

// Saved-byte gate failures: unsupported never enters an audit; approximate
// fidelity must select retypeset even with an older mode label; a valid Unicode
// map over GID0 must fail; unrelated codes cannot change behind stable Unicode.
const library=process.env.SHIORI_PDFIUM_DIR?`${process.env.SHIORI_PDFIUM_DIR}/libpdfium.so`:'vendor/pdfium/linux-x64/lib/libpdfium.so';
const directory='test-artifacts/retypeset-oracle-m2';
const loadFont=(name:string)=>readFile(name.startsWith('Noto')?`src/assets/fonts/${name}`:`node_modules/@docx-editor.dev/fonts/assets/${name}`);

test('unsupported outcomes are rejected before opening any sample',async()=>{
 await expect(auditCorpusSample({} as ReturnType<typeof openPdfium>,'unsupported',directory,{originalText:'A',text:'B',coverRects:[]},{},true,undefined,'unsupported')).rejects.toThrow('unsupported');
 await expect(auditCorpusSample({} as ReturnType<typeof openPdfium>,'unsupported',directory,{originalText:'A',text:'B',coverRects:[]},{},true,undefined,{overlayId:'edit',mode:'unsupported',fidelity:'approximate'})).rejects.toThrow('unsupported');
});

test.skipIf(!existsSync(library))('saved production retypeset passes its native gate, including wrapping, duplicates and approximate fidelity',async()=>{
 await mkdir(directory,{recursive:true});
 const command='bun test scripts/pdf-corpus/retypesetNative.test.ts';
 await writeFile(`${directory}/README.md`,`Regenerate: ${command}\nSaved PDFs and oracle JSON only; no corpus run or PNG generation.\n`);
 const reports=[];
 const native=openPdfium(library);
 try{
  for(const [name,text]of [['wrapped','new words that wrap'],['descriptor','new words that wrap'],['han','新的文字需要换行']] as const){
   const f=await fixture('BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET BT /F1 10 Tf 200 150 Td (ABCDE KEEP) Tj ET');
   if(name==='descriptor')f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict).set(PDFName.of('FontDescriptor'),f.doc.context.obj({Type:'FontDescriptor',FontName:'Courier',Flags:33,FontBBox:[0,-200,600,800],Ascent:800,Descent:-200,CapHeight:700,ItalicAngle:0,StemV:80}));
   const before=await f.doc.save({useObjectStreams:false}),edit=overlay({text});
   const result=await exportPdf(before,model([edit]),{mode:'flatten',inPlaceFallback:{loadFont}}),outcome=result.contentTextOutcomes![0]!;
   expect(outcome.mode).toBe('retypeset');
   await writeFile(`${directory}/${name}.before.pdf`,before);await writeFile(`${directory}/${name}.after.pdf`,result.bytes);
   await writeFile(`${directory}/${name}.edit.json`,JSON.stringify({edit,outcome},null,2));
   const a=native.inspectPage(before,0,true),b=native.inspectPage(result.bytes,0,true);
   expect(()=>compareNativePages(a,b,edit)).toThrow();
   const checked=await auditCorpusSample(native,name,directory,edit,{},true,undefined,outcome);
   expect(checked).toMatchObject({passed:true,oracleTier:'retypeset',changedPixelsOutsideRetypesetMask:0,maskDilationPx:1,qpdf:'clean'});
   expect(checked.nonNotdefGlyphs).toBeGreaterThan(0);reports.push(checked);
   expect(await auditCorpusSample(native,name,directory,edit,{},true,undefined,{...outcome,mode:'fallback-font',fidelity:'approximate'})).toMatchObject({passed:true,oracleTier:'retypeset'});
   if(name==='han'){
    const bad=await PDFDocument.load(result.bytes),fonts=bad.getPage(0).node.Resources()!.lookup(PDFName.of('Font'),PDFDict);
    const subset=fonts.entries().map(([,v])=>bad.context.lookup(v)).find(v=>v instanceof PDFDict&&v.get(PDFName.of('Subtype'))===PDFName.of('Type0')) as PDFDict;
    expect(subset).toBeDefined();
    // Preserve ToUnicode but send every emitted character code to CID/GID0.
    const zeros=Array.from({length:256},(_,i)=>`<${i.toString(16).padStart(4,'0')}> 0`).join(' ');
    subset.set(PDFName.of('Encoding'),bad.context.register(bad.context.flateStream(`1 begincodespacerange <0000> <ffff> endcodespacerange 256 begincidchar ${zeros} endcidchar`)));
    const child=subset.lookup(PDFName.of('DescendantFonts'),PDFArray).lookup(0,PDFDict);
    if(child.get(PDFName.of('Subtype'))===PDFName.of('CIDFontType2'))child.set(PDFName.of('CIDToGIDMap'),bad.context.register(bad.context.flateStream(new Uint8Array(131072))));
    const tofu=await bad.save({useObjectStreams:false}),observed=native.inspectPage(tofu,0,true);
    expect(observed.text.replace(/\s/gu,'')).toContain(text);
    expect(observed.glyphs.slice(0,Array.from(text).length).every(g=>g.nativePath!.length>0&&g.inkPixels!>0)).toBe(true);
    await writeFile(`${directory}/tofu.before.pdf`,before);await writeFile(`${directory}/tofu.after.pdf`,tofu);
    await expect(auditCorpusSample(native,'tofu',directory,edit,{},true,undefined,outcome)).rejects.toThrow(/notdef|replacement.*(ink|path)|blank/);
   }
  }
 }finally{native.close();await writeFile(`${directory}/report.json`,JSON.stringify({command,reports},null,2));}
});
