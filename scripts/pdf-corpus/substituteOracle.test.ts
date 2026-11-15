import {expect,test} from 'bun:test';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {PDFName,PDFDict} from 'pdf-lib';
import {fixture,model,overlay} from '../../src/pdf/export/contentText/fixtures.test-support';
import {exportPdf} from '../../src/pdf/export/exportPdf';
import {openPdfium} from '../pdf-inplace/nativePdfium';
import {auditCorpusSample,compareSubstitutedNativePages} from './oracle';

const glyph=(text:string,x:number,fontHash='source')=>({text,origin:[x,5],box:[x,4,x+1,6],fontHash,fontSize:10,nativePath:[{type:2,point:[1,1],closed:false}],inkPixels:2});
test('substitution oracle treats the whole owned run as replacement and keeps outside pixels strict',()=>{
 const before={width:10,height:10,text:'ZABC',glyphs:[glyph('Z',0),glyph('A',2),glyph('B',3),glyph('C',4)],pixels:Buffer.alloc(1600,255)};
 const after={...before,text:'ZAXC',glyphs:[glyph('Z',0),glyph('A',2,'subset'),glyph('X',2.6,'subset'),glyph('C',3.2,'subset')],pixels:Buffer.from(before.pixels)};
 const edit={originalText:'ABC',text:'AXC',coverRects:[{x:1,y:3,w:5,h:4}]};
 expect(compareSubstitutedNativePages(before,after,edit)).toMatchObject({replacementGlyphs:3,changedPixelsOutsideBox:0});
 expect(()=>compareSubstitutedNativePages(before,{...after,glyphs:[glyph('Z',.02),...after.glyphs.slice(1)]},edit)).toThrow('drift');
 const pixels=Buffer.from(after.pixels);pixels[0]=0;
 expect(()=>compareSubstitutedNativePages(before,{...after,pixels},edit)).toThrow('outside');
 expect(()=>compareSubstitutedNativePages(before,{...after,glyphs:[after.glyphs[0]!,{...after.glyphs[1]!,origin:[2.2,5]},...after.glyphs.slice(2)]},edit)).toThrow('origin');
});

test('native substitution exports preserve all outside pixels, search text and valid Type0 subsets',async()=>{
 const directory='test-artifacts/substitute-native';await mkdir(directory,{recursive:true});
 const command='bun test scripts/pdf-corpus/substituteOracle.test.ts';
 await writeFile(`${directory}/README.md`,`Regenerate with: ${command}\n`);
 const native=openPdfium(process.env.SHIORI_PDFIUM_DIR?`${process.env.SHIORI_PDFIUM_DIR}/libpdfium.so`:'vendor/pdfium/linux-x64/lib/libpdfium.so');
 const reports=[];
 try{
  for(const [name,base,text]of [['times','Times-Roman','AX'],['calibri','Calibri','AX'],['cambria','Cambria','AX'],['han','Times-Roman','漢'],['kana','Times-Roman','かな'],['type3','Courier','AX']]as const){
   const f=await fixture('q 0.8 0.9 1 rg 0 0 300 200 re f Q BT /F1 10 Tf 50 100 Td (ABCDE) Tj [-1000] TJ (Z) Tj ET');
   const font=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict);
   font.set(PDFName.of('BaseFont'),PDFName.of(base));font.delete(PDFName.of('ToUnicode'));
   if(name==='type3'){
    font.set(PDFName.of('Subtype'),PDFName.of('Type3'));font.set(PDFName.of('FontMatrix'),f.doc.context.obj([.001,0,0,.001,0,0]));font.set(PDFName.of('FontBBox'),f.doc.context.obj([0,0,600,700]));
    const procs:Record<string,unknown>={};for(const ch of 'ABCDEZ')procs[ch]=f.doc.context.register(f.doc.context.stream(new TextEncoder().encode('600 0 0 0 500 700 d1 0 0 500 700 re f')));
    font.set(PDFName.of('CharProcs'),f.doc.context.obj(procs));font.set(PDFName.of('Resources'),f.doc.context.obj({}));
   }
   const edit=overlay({text,coverRects:[{x:49,y:97,w:32,h:14}]});
   const before=await f.doc.save({useObjectStreams:false});await writeFile(`${directory}/${name}.before.pdf`,before);
   const chosen:string[]=[];
   const result=await exportPdf(before,model([edit]),{mode:'flatten',inPlaceFallback:{loadFont:async name=>{chosen.push(name);return readFile(name.startsWith('Noto')?`src/assets/fonts/${name}`:`node_modules/@docx-editor.dev/fonts/assets/${name}`);}}});
   expect(result.contentTextOutcomes?.[0]?.mode).toBe('substituted');
   await writeFile(`${directory}/${name}.after.pdf`,result.bytes);await writeFile(`${directory}/${name}.edit.json`,JSON.stringify({edit,chosen,outcome:result.contentTextOutcomes?.[0]},null,2));
   const report=await auditCorpusSample(native,name,directory,edit,{},false,undefined,'substituted');
   expect(report.changedPixelsOutsideBox).toBe(0);expect(report.qpdf).toBe('clean');expect(report.passed).toBe(true);
   reports.push({...report,chosen});
  }
 }finally{native.close();await writeFile(`${directory}/report.json`,JSON.stringify({command,reports},null,2));}
});
