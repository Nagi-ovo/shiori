import {expect,test} from 'bun:test';
import {PDFDict,PDFName} from 'pdf-lib';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fixture,overlay} from './fixtures.test-support';
import {applyRetypesets} from './retypeset';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {retypesetScopes} from './retypesetScopes';
import {readRetypesetSource} from './retypesetSource';
import {openPdfium} from '../../../../scripts/pdf-inplace/nativePdfium';
import {compareRetypesetRaster} from '../../../../scripts/pdf-corpus/retypesetRaster';
import type {ContentTextOutcome} from './outcomes';

// Failure list is recorded in STATUS.md before these tests and implementation.
const directory='test-artifacts/r23-clip';
async function edit(f:Awaited<ReturnType<typeof fixture>>,text='ABCDEFGH'){
 const outcomes=new Map<string,ContentTextOutcome>();
 await applyRetypesets(f.page,[overlay({text})],outcomes,new Set(),{loadFont:name=>readFile(`node_modules/@docx-editor.dev/fonts/assets/${name}`)});
 return outcomes.get('edit')!;
}
function declaredInk(f:Awaited<ReturnType<typeof fixture>>){
 const font=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict);
 font.set(PDFName.of('FontDescriptor'),f.doc.context.obj({Type:'FontDescriptor',FontName:'Courier',FontBBox:[0,-250,600,850],Flags:33,Ascent:850,Descent:-250,CapHeight:700,ItalicAngle:0,StemV:80}));
}
function read(f:Awaited<ReturnType<typeof fixture>>){
 const s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);
 const ops=tokenizeContentStream(s.bytes);
 return{ops,glyphs:readRetypesetSource(f.page,ops).glyphs,scopes:retypesetScopes(ops)};
}
async function saved(name:string,f:Awaited<ReturnType<typeof fixture>>,before:Uint8Array,outcome:ContentTextOutcome){
 await mkdir(directory,{recursive:true});const after=await f.doc.save();
 await writeFile(`${directory}/${name}.before.pdf`,before);await writeFile(`${directory}/${name}.after.pdf`,after);
 const native=openPdfium('vendor/pdfium/linux-x64/lib/libpdfium.so');
 try{
  const a=native.inspectPage(before,0,true),b=native.inspectPage(after,0,true);
  const raster=compareRetypesetRaster(a,b,a.glyphs.filter(g=>g.origin[0]<180),b.glyphs.filter(g=>g.origin[0]<180));
  expect(raster.changedPixelsOutsideRetypesetMask).toBe(0);
  await writeFile(`${directory}/${name}.json`,JSON.stringify({command:'bun test src/pdf/export/contentText/retypesetClip.test.ts',outcome,raster,before:a.glyphs,after:b.glyphs},null,2));
  return{a,b};
 }finally{native.close();}
}
test('wrapped paragraph re-lays earlier inside its frame; hidden outsiders stay hidden',async()=>{
 const f=await fixture('q 49 75 28 40 re W n BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET 0 g 90 90 8 8 re f Q');declaredInk(f);
 const before=await f.doc.save(),outcome=await edit(f);
 expect(outcome.mode).toBe('retypeset');
 const gs=read(f).glyphs;
 expect(gs.filter(g=>g.y===100).map(g=>g.text).join('')).toBe('ABCD');
 expect(gs.filter(g=>g.y<100).map(g=>g.text).join('')).toBe('EFGH');
 const {b}=await saved('relayout',f,before,outcome);
 for(const g of b.glyphs.filter(g=>g.text.trim())){
  expect(g.inkPixels).toBeGreaterThan(0);
  expect(g.inkBox[0]).toBeGreaterThanOrEqual(49);expect(g.inkBox[2]).toBeLessThanOrEqual(77);
  expect(g.inkBox[1]).toBeGreaterThanOrEqual(75);expect(g.inkBox[3]).toBeLessThanOrEqual(115);
 }
 const pixel=(x:number,y:number)=>b.pixels![(Math.floor((b.height-y)*2)*600+Math.floor(x*2))*4]!;
 expect(pixel(94,94)).toBe(255);
});

for(const clip of ['49 95 40 20 re W n','49 75 m 90 75 l 60 115 l h W n'])test(`unsafe wrap refuses transactionally (${clip})`,async()=>{
 const f=await fixture(`q ${clip} BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET Q`);declaredInk(f);
 const before=inspectRunPage(f.page),outcome=await edit(f);
 expect(outcome).toMatchObject({mode:'unsupported',detail:expect.stringContaining('source-clip')});
 expect(inspectRunPage(f.page)).toEqual(before);
});

test('an unmeasurable font still refuses wrap under a page-sized clip',async()=>{
 const f=await fixture('q 0 0 300 200 re W n BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET Q');
 const font=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict);
 font.set(PDFName.of('BaseFont'),PDFName.of('Unmeasurable'));
 const before=inspectRunPage(f.page),outcome=await edit(f);
 expect(outcome).toMatchObject({mode:'unsupported',detail:expect.stringContaining('unknown-output-ink')});
 expect(inspectRunPage(f.page)).toEqual(before);
});

const title='BT /F1 20 Tf 24 TL 50 150 Td (ABCDEFGHIJ) Tj ET ';
const release='BT /F1 10 Tf 55 120 Td (Release) Tj ET ';
for(const scale of [1,2])test(`contained push clones its shared clip locally and retains outsiders (${scale})`,async()=>{
 const f=await fixture(`q 40 55 140 125 re W n ${title} q ${scale} 0 0 ${scale} 0 0 cm BT /F1 ${10/scale} Tf ${55/scale} ${120/scale} Td (Release) Tj ET Q 0 g 190 110 8 8 re f Q BT /F1 10 Tf 220 120 Td (OTHER) Tj ET`);
 const before=await f.doc.save(),old=read(f),outcome=await editTitle(f);
 expect(outcome).toMatchObject({mode:'retypeset',retypeset:{pushed:true,pushedDeltaPt:24,overflowInkOverlap:false}});
 const now=read(f),outside=(r:typeof now)=>r.glyphs.filter(g=>g.x>=220).map(g=>[g.text,g.x,g.y,r.scopes.get(g.glyph.opIndex)?.clip]);
 expect(outside(now)).toEqual(outside(old));
 const moved=now.glyphs.filter(g=>g.state.fontSize===10/scale&&g.x<180);
 expect(moved.map(g=>g.text).join('')).toBe('Release');expect(moved.every(g=>Math.abs(g.y-96)<1e-8)).toBe(true);
 for(const g of moved)expect(now.scopes.get(g.glyph.opIndex)?.clip).toEqual({x:40,y:55,w:140,h:125});
 const {a,b}=await saved(`push-${scale}`,f,before,outcome);
 const pixel=(p:typeof b,x:number,y:number)=>p.pixels![(Math.floor((p.height-y)*2)*600+Math.floor(x*2))*4]!;
 expect(pixel(a,194,114)).toBe(255);expect(pixel(b,194,114)).toBe(255);
 for(const g of b.glyphs.filter(g=>g.origin[1]===96&&g.text.trim()))expect(g.inkPixels).toBeGreaterThan(0);
});
async function editTitle(f:Awaited<ReturnType<typeof fixture>>,text='ABCDEFGHIJK'){
 const outcomes=new Map<string,ContentTextOutcome>();
 await applyRetypesets(f.page,[overlay({text,originalText:'ABCDEFGHIJ',coverRects:[{x:49,y:147,w:122,h:24}]})],outcomes,new Set(),{});
 return outcomes.get('edit')!;
}
for(const [reason,clip]of [
 ['source-ink-outside-clip','80 55 100 125 re W n'],
 ['destination-outside-clip','40 110 140 70 re W n'],
 ['unknown-clip','40 55 m 180 55 l 110 180 l h W n'],
] as const)test(`unsafe clipped push stays blocked (${reason})`,async()=>{
// r31: one letter more fits the title's own ink band (P2-A, retypesetEnvelopeOwnBand.test.ts).
// Three more letters need .83 of the size, below the .85 floor, so the
// clip refusal stays the outcome under test.
 const f=await fixture(title+`q ${clip} ${release} Q`),old=read(f),outcome=await editTitle(f,'ABCDEFGHIJKLM');
 expect(outcome).toMatchObject({mode:'retypeset',retypeset:{pushed:false,pushReason:`push-blocked-by-${reason}`}});
 const following=(r:typeof old)=>r.glyphs.filter(g=>g.state.fontSize===10).map(g=>[g.text,g.x,g.y,r.scopes.get(g.glyph.opIndex)?.clip]);
 expect(following(read(f))).toEqual(following(old));
});

test('clip walker uses the complete path at its end and tracks text clipping as unknown',()=>{
 for(const stream of [
  '0 0 100 100 re W 150 0 100 100 re n BT (A) Tj ET',
  'BT 7 Tr (A) Tj ET BT (B) Tj ET',
  '1 .00000000001 0 1 0 0 cm 0 0 100 100 re W n BT (A) Tj ET',
 ]){
  const ops=tokenizeContentStream(new TextEncoder().encode(stream)),scopes=retypesetScopes(ops),show=ops.findLastIndex(o=>o.operator==='Tj');
  expect(scopes.get(show)?.clip).toBeNull();
 }
});

test('nested unknown clips and reflected rectangles restore through Q',()=>{
 const stream='q 10 20 100 140 re W n q 1 0 0 -1 0 200 cm 20 50 70 100 re W* n BT (A) Tj ET q 0 0 m 1 0 l 0 1 l h W n BT (B) Tj ET Q BT (C) Tj ET Q BT (D) Tj ET Q BT (E) Tj ET';
 const ops=tokenizeContentStream(new TextEncoder().encode(stream)),scopes=retypesetScopes(ops),shows=ops.flatMap((o,i)=>o.operator==='Tj'?[i]:[]);
 expect(shows.map(i=>scopes.get(i)?.clip)).toEqual([
  {x:20,y:50,w:70,h:100},null,{x:20,y:50,w:70,h:100},{x:10,y:20,w:100,h:140},undefined,
 ]);
});
