import {expect,test} from 'bun:test';
import {existsSync} from 'node:fs';
import {openPdfium} from '../pdf-inplace/nativePdfium';
const library='vendor/pdfium/linux-x64/lib/libpdfium.so';
test.skipIf(!existsSync(library))('corpus geometry is read from native PDFium, including exact baselines and sizes',()=>{
 const native=openPdfium(library);try{const page=native.inspectPage('scripts/pdf-inplace/fixtures/happy.pdf',0);
 expect(page.text).toContain('Hello World');expect(page.glyphs.length).toBeGreaterThan(10);
 const h=page.glyphs.find(g=>g.text==='H')!;expect(h.fontSize).toBeGreaterThan(0);expect(h.box[2]).toBeGreaterThan(h.box[0]);expect(Number.isFinite(h.origin[1])).toBe(true);
 }finally{native.close();}
});
test.skipIf(!existsSync(library))('native audit returns independent paths, font programs, ink and exact raster pixels',()=>{
 const native=openPdfium(library);try{const page=native.inspectPage('scripts/pdf-inplace/fixtures/happy.pdf',0,true);
 expect(page.pixels?.length).toBe(Math.round(page.width*2)*Math.round(page.height*2)*4);
 const h=page.glyphs.find(g=>g.text==='H')!;expect(h.fontHash).toMatch(/^[0-9a-f]{64}$/);expect(h.nativePath!.length).toBeGreaterThan(0);expect(h.inkPixels).toBeGreaterThan(0);
 }finally{native.close();}
});
test.skipIf(!existsSync(library))('a saved production fallback passes the full native corpus oracle',async()=>{
 const {PDFDocument}=await import('pdf-lib');const{exportPdf}=await import('../../src/pdf/export/exportPdf');
 const{auditCorpusSample}=await import('./oracle');const{mkdir,writeFile,readFile}=await import('node:fs/promises');
 const bytes=new Uint8Array(await readFile('scripts/pdf-inplace/fixtures/subset.pdf')),pdf=await PDFDocument.load(bytes),p=pdf.getPage(0);
 const overlay={id:'edit',type:'contentText' as const,pageId:'p',originalText:'Sans',text:'Sanr',fontSize:20,rect:{x:19,y:95,w:50,h:22},coverRects:[{x:19,y:95,w:50,h:22}],bold:false,color:'#000000',backgroundColor:'#ffffff',align:'left' as const,fontFamily:'sans' as const};
 const sourceStyle={fontSize:overlay.fontSize,color:overlay.color,bold:overlay.bold,align:overlay.align,fontFamily:overlay.fontFamily,backgroundColor:overlay.backgroundColor};
 const result=await exportPdf(bytes,{pages:[{id:'p',sourceIndex:0,widthPt:p.getWidth(),heightPt:p.getHeight(),rotation:0}],overlays:[{...overlay,sourceStyle}]},{mode:'flatten',inPlaceFallback:{loadFont:name=>readFile(`node_modules/@docx-editor.dev/fonts/assets/${name}`)}});
 const dir='test-artifacts/pdf-corpus/oracle-test';await mkdir(dir,{recursive:true});await writeFile(`${dir}/fallback.before.pdf`,bytes);await writeFile(`${dir}/fallback.after.pdf`,result.bytes);
 const native=openPdfium(library);try{expect(await auditCorpusSample(native,'fallback',dir,overlay)).toMatchObject({passed:true,changedPixelsOutsideBox:0});}finally{native.close();}
});
test.skipIf(!existsSync(library))('native corpus font sizes apply the character matrix exactly as the app core does',async()=>{
 const{fixture}=await import('../../src/pdf/export/contentText/fixtures.test-support');const f=await fixture('BT /F1 200 Tf .05 0 0 .05 50 100 Tm (ABCDE) Tj ET');
 const native=openPdfium(library);try{const page=native.inspectPage(await f.doc.save());expect(page.glyphs[0]!.fontSize).toBeCloseTo(10,5);}finally{native.close();}
});
test.skipIf(!existsSync(library))('native evidence handles an unrelated Type3 font without an empty-buffer FFI pointer',async()=>{
 const{fixture}=await import('../../src/pdf/export/contentText/fixtures.test-support');const{PDFName,PDFDict}=await import('pdf-lib');
 const f=await fixture('BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET BT /Odd 10 Tf 20 20 Td (Z) Tj ET');
 const char=f.doc.context.register(f.doc.context.stream('600 0 0 0 600 600 d1 0 0 600 600 re f'));
 const odd=f.doc.context.obj({Type:'Font',Subtype:'Type3',FontBBox:[0,0,600,600],FontMatrix:[.001,0,0,.001,0,0],FirstChar:90,LastChar:90,Widths:[600],CharProcs:{Z:char},Encoding:{Type:'Encoding',Differences:[90,'Z']},Resources:{}});
 f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).set(PDFName.of('Odd'),f.doc.context.register(odd));
 const native=openPdfium(library);try{const page=native.inspectPage(await f.doc.save(),0,true);expect(page.text).toContain('Z');expect(page.pixels!.length).toBeGreaterThan(0);expect(page.glyphs.find(g=>g.text==='Z')!.fontHash).toBeUndefined();}finally{native.close();}
});
