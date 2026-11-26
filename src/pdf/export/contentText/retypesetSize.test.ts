import {expect,test} from 'bun:test';
import {PDFDocument} from 'pdf-lib';
import {resolve} from 'node:path';
import {openPdfium} from '../../../../scripts/pdf-inplace/nativePdfium';
import {exportPdf} from '../exportPdf';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import {fixture,overlay,model} from './fixtures.test-support';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';

// Failure list, written before the writer change. A toolbar size request on
// editable source text can fail by:
//  1. a text change plus size serializing at the source size while the
//     outcome claims success;
//  2. a size-only change (same text) being an idle success that writes nothing;
//  3. leaking the new Tf to later shows in the same text object (missing
//     text-state restoration) or to an unrelated run elsewhere on the page;
//  4. resizing unselected glyphs that share the edited line;
//  5. ignoring the actual text/CTM matrices (Tf must scale, matrices stay);
//  6. a fit ladder silently shrinking the requested size back down, or any
//     other path that cannot honour the size still reporting success;
//  7. the editable-annotation and flatten exports routing differently.
const loadFont=(name:string)=>readFile(name.startsWith('Noto')?`src/assets/fonts/${name}`:`node_modules/@docx-editor.dev/fonts/assets/${name}`);
// Native readback needs the vendored Linux PDFium; elsewhere this suite skips.
const library=resolve(process.env.SHIORI_PDFIUM_DIR??'vendor/pdfium/linux-x64/lib','libpdfium.so');
const nativeTest=test.skipIf(!existsSync(library));
const native=()=>openPdfium(library);
type Glyph={text:string;origin:[number,number];fontSize:number;box:number[]};
const glyphs=(bytes:Uint8Array):Glyph[]=>{const n=native();try{return n.inspectPage(bytes,0).glyphs.filter(g=>g.text.trim()).map(({text,origin,fontSize,box})=>({text,origin,fontSize,box}));}finally{n.close();}};
const sizes=(gs:Glyph[],y:number)=>gs.filter(g=>Math.abs(g.origin[1]-y)<1).map(g=>[g.text,+g.fontSize.toFixed(2)]);
// The source style stays the fixture's 10 pt: only the toolbar value changes.
const run=async(stream:string,patch:Partial<ReturnType<typeof overlay>>,mode:'flatten'|'annotations'='flatten')=>{
 const f=await fixture(stream),before=await f.doc.save();
 const result=await exportPdf(before,model([{...overlay(),...patch}]),{mode,inPlaceFallback:{loadFont}});
 return {before,result,outcome:result.contentTextOutcomes?.[0]};
};

for(const mode of ['flatten','annotations'] as const)nativeTest(`${mode}: ABCDE → AXCDE at 15 pt serializes 15 pt glyphs; a second 10 pt run is untouched`,async()=>{
 const {before,result,outcome}=await run('BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET BT /F1 10 Tf 50 40 Td (KEEP) Tj ET',{text:'AXCDE',fontSize:15},mode);
 expect(outcome?.mode).not.toBe('unsupported');
 const after=glyphs(result.bytes);
 expect(sizes(after,100)).toEqual([['A',15],['X',15],['C',15],['D',15],['E',15]]);
 expect(after.filter(g=>g.origin[1]<60)).toEqual(glyphs(before).filter(g=>g.origin[1]<60));
});

nativeTest('size-only change with unchanged text serializes the new size',async()=>{
 const {result,outcome}=await run('BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET',{text:'ABCDE',fontSize:15});
 expect(outcome?.mode).not.toBe('unsupported');
 expect(sizes(glyphs(result.bytes),100)).toEqual([['A',15],['B',15],['C',15],['D',15],['E',15]]);
});

nativeTest('later shows in the same text object keep their source size and position',async()=>{
 const stream='BT /F1 10 Tf 50 100 Td (ABCDE) Tj 0 -30 Td (FGH) Tj ET';
 const {before,result}=await run(stream,{text:'AXCDE',fontSize:15});
 const after=glyphs(result.bytes);
 expect(sizes(after,100).map(s=>s[1])).toEqual([15,15,15,15,15]);
 expect(after.filter(g=>g.origin[1]<80)).toEqual(glyphs(before).filter(g=>g.origin[1]<80));
});

nativeTest('unselected glyphs on the edited line keep 10 pt',async()=>{
 const {result}=await run('BT /F1 10 Tf 50 100 Td (ABCDE QRS) Tj ET',{text:'AXCDE',fontSize:15});
 const line=sizes(glyphs(result.bytes),100);
 expect(line.filter(([t])=>'AXCDE'.includes(t as string)).map(s=>s[1])).toEqual([15,15,15,15,15]);
 expect(line.filter(([t])=>'QRS'.includes(t as string))).toEqual([['Q',10],['R',10],['S',10]]);
});

nativeTest('a scaled text matrix keeps its matrix; Tf carries the size change',async()=>{
 const {result,outcome}=await run('BT /F1 5 Tf 2 0 0 2 50 100 Tm (ABCDE) Tj ET',{text:'AXCDE',fontSize:15});
 expect(outcome?.mode).not.toBe('unsupported');
 expect(sizes(glyphs(result.bytes),100).map(s=>s[1])).toEqual([15,15,15,15,15]);
 const s=inspectRunPage((await PDFDocument.load(result.bytes)).getPage(0));if(!s.ok)throw Error(s.reason);
 expect(new TextDecoder().decode(s.bytes)).toMatch(/2 0 0 2 [\d.]+ [\d.]+ Tm \/F1 7\.5 Tf/);
});

nativeTest('a size that a bounded frame cannot hold is refused, never written at another size',async()=>{
 // A filled cell exactly around the source line: 30 pt does not fit and the
 // frame ladder would otherwise shrink the output back towards the source.
 const {before,result,outcome}=await run('0.9 g 48 96 34 16 re f 0 g BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET',{text:'ABCDE',fontSize:30});
 expect(outcome).toMatchObject({mode:'unsupported',reason:'style-change'});
 expect(outcome?.detail).toContain('size-request-unmet');
 expect(glyphs(result.bytes)).toEqual(glyphs(before));
});

nativeTest('a rotated source keeps its orientation at the requested size',async()=>{
 const box={x:91,y:49,w:13,h:32};
 const {before,result,outcome}=await run('BT /F1 10 Tf 0 1 -1 0 100 50 Tm (ABCDE) Tj ET',{text:'AXCDE',fontSize:15,coverRects:[box],rect:box});
 expect(outcome?.mode).toBe('retypeset');
 expect(glyphs(result.bytes).map(g=>[g.text,+g.fontSize.toFixed(2),+g.origin[0].toFixed(2)])).toEqual([['A',15,100],['X',15,100],['C',15,100],['D',15,100],['E',15,100]]);
 const n=native();
 try{const source=n.inspectPage(before,0).glyphs[0]!.angle;expect(n.inspectPage(result.bytes,0).glyphs.every(g=>Math.abs(g.angle-source)<1e-6)).toBe(true);}finally{n.close();}
});

nativeTest('mixed source sizes scale together; the dominant size lands on the request',async()=>{
 const {result}=await run('BT /F1 10 Tf 50 100 Td (ABC) Tj /F1 6 Tf (DE) Tj ET',{text:'AXCDE',fontSize:15});
 expect(sizes(glyphs(result.bytes),100)).toEqual([['A',15],['X',15],['C',15],['D',9],['E',9]]);
});

nativeTest('fill colours and a following run keep their source state',async()=>{
 const {result}=await run('BT 1 0 0 rg /F1 10 Tf 50 100 Td (ABCDE) Tj 0 0 1 rg (QR) Tj ET',{text:'AXCDE',fontSize:15,color:'#ff0000'});
 const after=glyphs(result.bytes),line=sizes(after,100);
 expect(line).toEqual([['A',15],['X',15],['C',15],['D',15],['E',15],['Q',10],['R',10]]);
 // The grown run owns more of its line; the suffix moves only to clear it.
 expect(after.find(g=>g.text==='Q')!.box[0]!).toBeGreaterThanOrEqual(after.find(g=>g.text==='E')!.box[2]!);
 const s=inspectRunPage((await PDFDocument.load(result.bytes)).getPage(0));if(!s.ok)throw Error(s.reason);
 const stream=new TextDecoder().decode(s.bytes);
 expect(stream.indexOf('1 0 0 rg')).toBeLessThan(stream.indexOf('/F1 15 Tf'));
 expect(stream.indexOf('0 0 1 rg')).toBeLessThan(stream.indexOf('<5152>'));
 expect(stream.indexOf('0 0 1 rg')).toBeGreaterThan(stream.indexOf('/F1 15 Tf'));
});
