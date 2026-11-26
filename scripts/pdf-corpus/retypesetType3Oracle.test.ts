import {expect,test} from 'bun:test';
import {PDFDict,PDFDocument,PDFName} from 'pdf-lib';
import {readFile} from 'node:fs/promises';
import {assertScaledColumnType3Glyphs} from './retypesetType3Oracle';
import {openPdfium} from '../pdf-inplace/nativePdfium';
import {inspectRunPage} from '../../src/pdf/export/contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../../src/pdf/export/contentStreamEdit/tokenizer';
import {readRetypesetSource} from '../../src/pdf/export/contentText/retypesetSource';

// Failure list before scale-aware Type 3 evidence: unchanged code and font
// data at a uniform .85..1 size must pass; altered CharProcs with the same
// bounding box, changed codes, anisotropic shape, a non-column selection,
// missing source labels, mixed scales and excessive shrink must fail.
async function sample(scale=.9,mixed=false){
 const bytes=await readFile('scripts/pdf-corpus/fixtures/vertical/vert-browser-jp-kumo.pdf');
 const before=await PDFDocument.load(bytes),after=await PDFDocument.load(bytes),page=before.getPage(1),next=after.getPage(1);
 const native=openPdfium('vendor/pdfium/linux-x64/lib/libpdfium.so');
 let glyphs;try{glyphs=native.inspectPage(bytes,1,true).glyphs.filter(g=>g.origin[0]<110).slice(0,4);}finally{native.close();}
 // An independent saved-stream size change: preserve every other byte.
 const c=inspectRunPage(next);if(!c.ok)throw Error(c.reason);
 const ops=tokenizeContentStream(c.bytes),read=readRetypesetSource(next,ops,undefined,undefined,{flippedType3:true});
 const old=read.glyphs.find(g=>Math.hypot(g.x-glyphs[0]!.origin[0],g.y-glyphs[0]!.origin[1])<.01)!;
 let text=Buffer.from(c.bytes).toString('latin1');const size=old.state.fontSize;
 if(mixed){const op=ops[old.glyph.opIndex]!,font=PDFName.of(old.glyph.fontName);text=text.slice(0,op.start)+`${font} ${size*.95} Tf `+text.slice(op.start,op.end)+` ${font} ${size} Tf `+text.slice(op.end);}
 next.node.set(PDFName.of('Contents'),after.context.register(after.context.flateStream(text.replaceAll(`${size} Tf`,`${size*scale} Tf`))));
 // Use reopened native output instead of predicting its bounding boxes.
 const reader=openPdfium('vendor/pdfium/linux-x64/lib/libpdfium.so');
 let output;try{output=reader.inspectPage(await after.save(),1,true).glyphs.filter(g=>g.origin[0]<110).slice(0,4);}finally{reader.close();}
 return{page,next,glyphs,output};
}

test('Type 3 evidence accepts a uniform bounded size with saved code/font identity',async()=>{
 const f=await sample();expect(f.output[0]!.fontSize/f.glyphs[0]!.fontSize).toBeCloseTo(.9,4);expect(()=>assertScaledColumnType3Glyphs(f.page,f.next,f.glyphs,f.output,f.glyphs)).not.toThrow();
});

test('Type 3 scale evidence rejects changed procedures even with unchanged native extents',async()=>{
 const f=await sample(),fonts=f.next.node.Resources()!.lookup(PDFName.of('Font'),PDFDict);
 for(const [,ref]of fonts.entries()){
  const font=f.next.doc.context.lookup(ref,PDFDict),procs=font.lookupMaybe(PDFName.of('CharProcs'),PDFDict);
  if(procs)for(const [name]of procs.entries())procs.set(name,f.next.doc.context.register(f.next.doc.context.flateStream('1000 0 0 0 1000 1000 d1 0 0 1000 1000 re f')));
 }
 expect(()=>assertScaledColumnType3Glyphs(f.page,f.next,f.glyphs,f.output,f.glyphs)).toThrow('identity');
});

test('Type 3 scale evidence fails closed on missing source text, a non-column and native size/shape mismatch',async()=>{
 const f=await sample();
 expect(()=>assertScaledColumnType3Glyphs(f.page,f.next,f.glyphs.map(g=>({...g,text:'違'})),f.output,f.glyphs)).toThrow('identity');
 expect(()=>assertScaledColumnType3Glyphs(f.page,f.next,f.glyphs,f.output,f.glyphs.map(g=>({...g,origin:[g.origin[0],1]})))).toThrow('column');
 expect(()=>assertScaledColumnType3Glyphs(f.page,f.next,f.glyphs,f.output.map(g=>({...g,fontSize:g.fontSize*.7})),f.glyphs)).toThrow('size');
 expect(()=>assertScaledColumnType3Glyphs(f.page,f.next,f.glyphs,f.output.map(g=>({...g,box:[g.box[0],g.box[1],g.box[2]+2,g.box[3]]})),f.glyphs)).toThrow('extent');
});

test('Type 3 scale evidence refuses saved output below the size floor',async()=>{
 const f=await sample(.84);expect(()=>assertScaledColumnType3Glyphs(f.page,f.next,f.glyphs,f.output,f.glyphs)).toThrow('size');
});

test('Type 3 scale evidence refuses independently measured mixed cell sizes',async()=>{
 const f=await sample(.9,true);expect(new Set(f.output.map(g=>g.fontSize)).size).toBeGreaterThan(1);
 expect(()=>assertScaledColumnType3Glyphs(f.page,f.next,f.glyphs,f.output,f.glyphs)).toThrow('mixes');
});
