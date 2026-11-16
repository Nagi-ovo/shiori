import {expect,test} from 'bun:test';
import {PDFName} from 'pdf-lib';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {cffFixture} from './misdeclaredCff.test-support';
import {cidCff} from '../fontCoverage/fixtures/cidCff';
import {tinyTtf} from '../fontCoverage/fixtures/programs';
import {fontCoverageFromDict} from '../fontCoverage/pdfLibAdapter';
import {inspectRunPage,resolveRunFonts} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {traceReflowSource} from './reflowTrace';
import {streamInkResolver} from './reflowInk';
import {retypesetInk} from './retypesetInk';
import {readRetypesetSource} from './retypesetSource';
import {applyRetypesets} from './retypeset';
import {overlay} from './fixtures.test-support';
import type {ContentTextOutcome} from './outcomes';
import {openPdfium} from '../../../../scripts/pdf-inplace/nativePdfium';
import {compareRetypesetRaster} from '../../../../scripts/pdf-corpus/retypesetRaster';

// Failure inventory was recorded in STATUS.md before tests/implementation.
function inspect(f:Awaited<ReturnType<typeof cffFixture>>){
 const s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);
 const fonts=resolveRunFonts(f.page),ops=tokenizeContentStream(s.bytes),trace=traceReflowSource(ops,fonts,s.sourceHash);
 const state=[...trace.shows.values()][0]!.before,g=readRetypesetSource(f.page,ops).glyphs[0]!;
 return{ink:streamInkResolver(f.page,fonts)('F1',1,state),placed:retypesetInk(f.page,fonts,ops)(fonts[0]!,1,g.state,g.x,g.y)};
}
async function edit(f:Awaited<ReturnType<typeof cffFixture>>){
 const outcomes=new Map<string,ContentTextOutcome>();
 await applyRetypesets(f.page,[overlay({originalText:'AAAAA',text:'AAAAAAAA'})],outcomes,new Set(),{loadFont:name=>readFile(`node_modules/@docx-editor.dev/fonts/assets/${name}`)});
 return outcomes.get('edit')!;
}
test('misdeclared CID CFF proves actual outline and writes a contained wrap through native PDFium',async()=>{
 const f=await cffFixture(),before=await f.doc.save();
 expect(fontCoverageFromDict(f.font).canEncode('A')).toMatchObject({ok:true,bytes:Uint8Array.of(0,1)});
 expect(inspect(f)).toMatchObject({ink:{box:{x:0,y:0,w:1,h:1},conservative:false,glyph:{gid:1}},placed:{known:true}});
 const declared=await cffFixture(),ctx=declared.doc.context;
 declared.child.set(PDFName.of('Subtype'),PDFName.of('CIDFontType0'));declared.child.delete(PDFName.of('CIDToGIDMap'));
 declared.descriptor.delete(PDFName.of('FontFile2'));
 declared.descriptor.set(PDFName.of('FontFile3'),ctx.register(ctx.flateStream(cidCff(),{Subtype:'CIDFontType0C'})));
 expect(inspect(declared)).toEqual(inspect(f));
 const outcome=await edit(f);expect(outcome.mode).toBe('retypeset');
 const after=await f.doc.save(),native=openPdfium('vendor/pdfium/linux-x64/lib/libpdfium.so');
 try{
  const a=native.inspectPage(before,0,true),b=native.inspectPage(after,0,true),glyphs=b.glyphs.filter(g=>g.text==='A');
  const correctlyDeclared=native.inspectPage(await declared.doc.save(),0,true);
  const outlines=(p:typeof a)=>p.glyphs.map(g=>({text:g.text,inkBox:g.inkBox,fontHash:g.fontHash,path:g.nativePath}));
  expect(outlines(a)).toEqual(outlines(correctlyDeclared));
  expect(glyphs).toHaveLength(8);expect(new Set(glyphs.map(g=>g.origin[1])).size).toBe(2);
  for(const g of glyphs){
   expect(g.inkPixels).toBeGreaterThan(0);expect(g.nativePath!.length).toBeGreaterThan(0);
   expect(g.fontHash).toBe(a.glyphs[0]!.fontHash);expect(g.nativePath).toEqual(a.glyphs[0]!.nativePath);
   expect(g.inkBox[0]).toBeGreaterThanOrEqual(49);expect(g.inkBox[2]).toBeLessThanOrEqual(82);
   expect(g.inkBox[1]).toBeGreaterThanOrEqual(65);expect(g.inkBox[3]).toBeLessThanOrEqual(115);
  }
  const raster=compareRetypesetRaster(a,b,a.glyphs,b.glyphs);expect(raster.changedPixelsOutsideRetypesetMask).toBe(0);
  const out='test-artifacts/r23-ink/synthetic';await mkdir(out,{recursive:true});
  await writeFile(`${out}/wrap.before.pdf`,before);await writeFile(`${out}/wrap.after.pdf`,after);
  await writeFile(`${out}/report.json`,JSON.stringify({command:'bun test src/pdf/export/contentText/misdeclaredCff.test.ts',outcome,raster,before:a.glyphs,after:b.glyphs},null,2));
 }finally{native.close();}
});
test('proved CFF ink leaving a short source clip still refuses transactionally',async()=>{
 const f=await cffFixture(cidCff(),'49 99 33 16 re W n'),before=inspectRunPage(f.page);
 const outcome=await edit(f);
 expect(outcome).toMatchObject({mode:'unsupported',detail:expect.stringContaining('insufficient-clip-space')});
 expect(inspectRunPage(f.page)).toEqual(before);
});
for(const [name,program]of [['non-CFF',Uint8Array.of(0,1,0,0)],['truncated-CFF',cidCff().slice(0,20)],['missing-charstring',cidCff({missingGlyph:true})],['broken-charstring',cidCff({brokenGlyph:true})],['FD-transform',cidCff({matrix:[2,0,0,2,0,0]})]] as const){
 test(`${name} retains unknown ink and refuses a clipped wrap despite FontBBox`,async()=>{
  const f=await cffFixture(program),before=inspectRunPage(f.page);
  expect(inspect(f)).toMatchObject({ink:undefined,placed:{known:false}});
  expect(await edit(f)).toMatchObject({mode:'unsupported',detail:expect.stringContaining('unknown-output-ink')});
  expect(inspectRunPage(f.page)).toEqual(before);
 });
}
test('an unproved descendant FontMatrix cannot use the CFF hull or FontBBox',async()=>{
 const f=await cffFixture();f.child.set(PDFName.of('FontMatrix'),f.doc.context.obj([2,0,0,2,0,0]));
 expect(inspect(f)).toMatchObject({ink:undefined,placed:{known:false}});
 expect(await edit(f)).toMatchObject({mode:'unsupported',detail:expect.stringContaining('unknown-output-ink')});
});
test('a conflicting CIDToGIDMap cannot supply the CFF hull of another glyph',async()=>{
 const f=await cffFixture();f.map[3]=2;
 f.child.set(PDFName.of('CIDToGIDMap'),f.doc.context.register(f.doc.context.flateStream(f.map)));
 expect(inspect(f)).toMatchObject({ink:undefined,placed:{known:false}});
 expect(await edit(f)).toMatchObject({mode:'unsupported',detail:expect.stringContaining('unknown-output-ink')});
});
test('actual TrueType CIDFontType2 keeps its mapped glyf ink and contained wrapping',async()=>{
 const f=await cffFixture(tinyTtf());f.map[3]=7;
 f.child.set(PDFName.of('CIDToGIDMap'),f.doc.context.register(f.doc.context.flateStream(f.map)));
 expect(inspect(f)).toMatchObject({ink:{box:{x:0,y:0,w:1,h:1},conservative:false,glyph:{gid:7}},placed:{known:true}});
 expect(await edit(f)).toMatchObject({mode:'retypeset'});
});
