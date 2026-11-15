// Focused native experiment: bun research/reflow-proto/type1NativeProbe.ts
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {PDFDocument,PDFName} from 'pdf-lib';
import {tinyType1,nums} from '../../src/pdf/export/fontCoverage/fixtures/type1';
import {fontInputFromDict} from '../../src/pdf/export/fontCoverage/pdfLibAdapter';
import {type1ProgramWidths} from './type1Metrics';
import {openPdfium} from '../../scripts/pdf-inplace/nativePdfium';

const out=resolve('test-artifacts/reflow-type1-native');await mkdir(out,{recursive:true});
const doc=await PDFDocument.create(),page=doc.addPage([300,200]);
const glyph=(numerator:number,denominator:number)=>Uint8Array.from([
 ...nums(0,numerator,denominator),12,12,13,...nums(10,0),21,...nums(200,0),5,...nums(0,500),5,...nums(-200,0),5,9,14]);
const program=tinyType1({glyphs:{A:glyph(4999,10),B:glyph(6004,10),C:glyph(1333,3)}});
const descriptor=doc.context.register(doc.context.obj({Type:'FontDescriptor',FontName:'Tiny',Flags:32,
 FontBBox:[0,0,1000,800],ItalicAngle:0,Ascent:800,Descent:-200,CapHeight:800,StemV:80,
 FontFile:doc.context.register(doc.context.stream(program.program,{Length1:program.length1,Length2:program.length2,Length3:program.length3}))}));
const font=doc.context.obj({Type:'Font',Subtype:'Type1',BaseFont:'Tiny',FirstChar:65,LastChar:67,
 Widths:[499.9,600.4,1333/3],Encoding:'WinAnsiEncoding',FontDescriptor:descriptor,
 ToUnicode:doc.context.register(doc.context.stream('1 beginbfrange <41> <43> <0041> endbfrange'))});
page.node.set(PDFName.of('Resources'),doc.context.obj({Font:{F1:doc.context.register(font)}}));
page.node.set(PDFName.of('Contents'),doc.context.register(doc.context.stream('BT /F1 10 Tf 50 150 Td (AAAA) Tj 0 -20 Td (BBBB) Tj 0 -20 Td (CCCC) Tj ET')));
const path=resolve(out,'fractional-widths.pdf');await writeFile(path,await doc.save());
const widths=type1ProgramWidths(fontInputFromDict(font));
const native=openPdfium(process.env.PDFIUM_LIBRARY??'/workspace/shiori-wt/pdf-inplace-ui/vendor/pdfium/linux-x64/lib/libpdfium.so');
try{
 const snapshot=native.inspectPage(path,0,true);
 const rows=['A','B','C'].map(unicode=>{
  const glyphs=snapshot.glyphs.filter(g=>g.text===unicode),programWidth=widths.widths.get(unicode.charCodeAt(0))!;
  assert.equal(glyphs.length,4);
  const observed=glyphs.slice(1).map((g,i)=>(g.origin[0]-glyphs[i]!.origin[0])/10*1000);
  return {unicode,programWidth1000:programWidth,expectedNativeWidth1000:Math.trunc(programWidth),observedWidth1000:observed};
 });
 const passed=rows.every(r=>r.observedWidth1000.every(n=>Math.abs(n-r.expectedNativeWidth1000)<.002));
 await writeFile(resolve(out,'report.json'),JSON.stringify({command:'bun research/reflow-proto/type1NativeProbe.ts',rows,passed},null,2));
 console.log(JSON.stringify(rows));
 assert(passed);
}finally{native.close();}
