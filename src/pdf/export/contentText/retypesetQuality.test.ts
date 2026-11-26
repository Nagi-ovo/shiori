import {expect,test} from 'bun:test';
import {PDFDict,PDFDocument,PDFName} from 'pdf-lib';
import {existsSync} from 'node:fs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fixture,overlay} from './fixtures.test-support';
import {applyRetypesets} from './retypeset';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {readRetypesetSource} from './retypesetSource';
import {openPdfium} from '../../../../scripts/pdf-inplace/nativePdfium';
import {applyContentTextEdits} from './apply';
import type {ContentTextOverlay} from '../../model/types';
import type {ContentTextOutcome} from './outcomes';

// Failure list precedes implementation in STATUS.md. Exercise saved production
// streams and native glyph/raster geometry, rather than a layout implementation.
const loadFont=(name:string)=>readFile(name.startsWith('Noto')?`src/assets/fonts/${name}`:`node_modules/@docx-editor.dev/fonts/assets/${name}`);
function read(page:Parameters<typeof inspectRunPage>[0]){
 const s=inspectRunPage(page);if(!s.ok)throw Error(s.reason);
 return{stream:new TextDecoder().decode(s.bytes),glyphs:readRetypesetSource(page,tokenizeContentStream(s.bytes)).glyphs};
}
async function edit(page:Parameters<typeof applyRetypesets>[0],e:ContentTextOverlay){
 const outcomes=new Map<string,ContentTextOutcome>();await applyRetypesets(page,[e],outcomes,new Set(),{loadFont});
 expect(outcomes.get(e.id)?.mode).toBe('retypeset');return outcomes.get(e.id)!.retypeset!;
}
const positions=(gs:ReturnType<typeof read>['glyphs'])=>gs.map(g=>[g.text,g.glyph.fontName,g.glyph.code,g.x,g.y]);
for(const [replacement,nextY]of [['AXCDE',136],['ABCDEFGHI',122]] as const)test(`unchanged indented line keeps its original string and coordinates (${replacement})`,async()=>{
 const f=await fixture(`BT /F1 10 Tf 14 TL 50 150 Td (ABCDE) Tj 10 ${nextY-150} Td (REPORT: EXECUTIVE) Tj ET`);
 const before=read(f.page),later=before.glyphs.filter(g=>g.y===nextY);
 const m=await edit(f.page,overlay({text:replacement,coverRects:[{x:49,y:148,w:32,h:13}]}));
 const after=read(f.page);
 expect(after.stream).toContain('(REPORT: EXECUTIVE) Tj');
 expect(positions(after.glyphs.filter(g=>g.y===nextY))).toEqual(positions(later));
 expect(m).toMatchObject({unchangedLineDriftPt:0,pushed:false,pushedDeltaPt:0,overflowInkOverlap:false});
});
const title='BT /F1 20 Tf 24 TL 50 150 Td (ABCDEFGHIJ) Tj ET ';
const release='BT /F1 10 Tf 55 120 Td [(Release) -100 (2.0)] TJ ET ';
const longer=(text='ABCDEFGHIJK')=>overlay({text,originalText:'ABCDEFGHIJ',coverRects:[{x:49,y:147,w:122,h:24}]});
// r31: one letter more fits the title's own ink band (P2-A, retypesetEnvelopeOwnBand.test.ts).
// Three more letters need .83 of the size, below the .85 floor, so the
// push refusal below stays the outcome under test.
const beyondOwnBand=()=>longer('ABCDEFGHIJKLM');

test('same-column text and graphics share one delta; outsiders and spacing survive',async()=>{
 const f=await fixture(title+release+'0.4 g 80 90 30 6 re f BT /F1 10 Tf 220 120 Td (OTHER) Tj ET BT /F1 10 Tf 50 185 Td (HEADER) Tj ET');
 const before=await f.doc.save(),old=read(f.page),m=await edit(f.page,longer()),after=await f.doc.save();
 expect(m).toMatchObject({pushed:true,pushedDeltaPt:24,overflowInkOverlap:false});
 expect(m.pushedRegions.length).toBeGreaterThan(0);
 for(const r of m.pushedRegions)expect(r.after).toEqual({...r.before,y:r.before.y-24});
 const now=read(f.page);
 expect(positions(now.glyphs.filter(g=>g.x>=220||g.y===185))).toEqual(positions(old.glyphs.filter(g=>g.x>=220||g.y===185)));
 expect(positions(now.glyphs.filter(g=>g.y===96))).toEqual(positions(old.glyphs.filter(g=>g.y===120&&g.x<220)).map(p=>[...p.slice(0,4),96]));
 const native=openPdfium(resolve('vendor/pdfium/linux-x64/lib/libpdfium.so'));
 try{
  const a=native.inspectPage(before,0,true),b=native.inspectPage(after,0,true);
  const wrapped=b.glyphs.find(g=>g.text==='K')!,following=b.glyphs.find(g=>g.text==='R')!;
  expect(wrapped.inkBox[1]).toBeGreaterThan(following.inkBox[3]);
  // The filled rectangle moves from y=90..96 to y=66..72, unchanged in x.
  const pixel=(p:typeof b,x:number,y:number)=>p.pixels![(Math.floor((p.height-y)*2)*Math.round(p.width*2)+Math.floor(x*2))*4]!;
  expect(pixel(a,85,93)).toBeLessThan(200);expect(pixel(b,85,93)).toBe(255);expect(pixel(b,85,69)).toBeLessThan(200);
  // Approximate-only mask: old changed line boxes, new text, and both old
  // and translated following regions. No exact-tier mask code is touched.
  const boxes=[...a.glyphs,...b.glyphs].filter(g=>g.origin[0]<200&&g.origin[1]<180).map(g=>g.box);
  for(const r of m.pushedRegions)for(const box of [r.before,r.after])boxes.push([box.x,box.y,box.x+box.w,box.y+box.h]);
  let changedPixels=0,outsideMaskPixels=0;
  for(let i=0;i<a.pixels!.length;i+=4)if(a.pixels!.subarray(i,i+4).some((v,j)=>v!==b.pixels![i+j])){
   changedPixels++;const x=((i/4)%600)/2,y=a.height-Math.floor(i/4/600)/2;
   if(!boxes.some(([l,bot,r,t])=>x>=l-.5&&x<=r+.5&&y>=bot-.5&&y<=t+.5))outsideMaskPixels++;
  }
  expect(changedPixels).toBeGreaterThan(0);expect(outsideMaskPixels).toBe(0);
  const dir='test-artifacts/r22-quality';await mkdir(dir,{recursive:true});
  await writeFile(`${dir}/push.before.pdf`,before);await writeFile(`${dir}/push.after.pdf`,after);
  await writeFile(`${dir}/push.json`,JSON.stringify({command:'bun test src/pdf/export/contentText/retypesetQuality.test.ts',manifest:m,changedPixels,outsideMaskPixels,old:positions(old.glyphs),after:positions(now.glyphs)},null,2));
 }finally{native.close();}
});

for(const [name,obstacle]of [
 ['crop',''],
 ['foreign','0.3 g 110 82 130 22 re f'],
 ['clip','q 80 110 90 20 re W n '+release+'Q'],
] as const)test(`blocked push retains overflow and all following ink (${name})`,async()=>{
 const f=await fixture(title+(name==='clip'?'':release)+obstacle);
 // The crop boundary must block the affected block itself. A distant
 // bottom line across an absorbing gap is correctly left stationary.
 if(name==='crop')f.page.setCropBox(0,100,300,100);
 const before=read(f.page);
 const m=await edit(f.page,beyondOwnBand());
 expect(m.pushed).toBe(false);expect(m.pushReason).toMatch(/^push-blocked-by-/);expect(m.overflowInkOverlap).toBe(true);
 expect(positions(read(f.page).glyphs.filter(g=>g.state.fontSize===10))).toEqual(positions(before.glyphs.filter(g=>g.state.fontSize===10)));
 expect(read(f.page).glyphs.map(g=>g.text).join('')).toContain('ABCDEFGHIJK');
});

// Before the chain this full-measure line blocked the push. It shares x with
// no other column and lies outside the page head and foot, so the chain now
// moves it whole with the column text by the same delta, never a suffix.
test('a full-measure line below the column moves whole with it by one delta',async()=>{
 const f=await fixture(title+release+'BT /F1 10 Tf 20 102 Td (FULL WIDTH FOOTER OUTSIDE COLUMN) Tj ET');
 const before=read(f.page),m=await edit(f.page,longer());
 expect(m).toMatchObject({pushed:true,pushedDeltaPt:24,overflowInkOverlap:false,fitStrategy:'chain-push'});
 expect(positions(read(f.page).glyphs.filter(g=>g.state.fontSize===10))).toEqual(positions(before.glyphs.filter(g=>g.state.fontSize===10)).map(([t,font,code,x,y])=>[t,font,code,x,(y as number)-24]));
});

test('partially shared TJ show cannot move its other-column glyphs',async()=>{
 const f=await fixture(title+'BT /F1 10 Tf 55 120 Td [(Release) -15000 (OUTSIDER)] TJ ET');
 const old=read(f.page),m=await edit(f.page,beyondOwnBand());
 expect(m).toMatchObject({pushed:false,overflowInkOverlap:true});expect(m.pushReason).toMatch(/^push-blocked-by-/);
 expect(positions(read(f.page).glyphs.filter(g=>g.state.fontSize===10))).toEqual(positions(old.glyphs.filter(g=>g.state.fontSize===10)));
});

const samples=process.env.RETYPESET_QUALITY_SAMPLES??'test-artifacts/pdf-corpus-r21/samples';
for(const id of ['gsa-1-0-same-length','zh-d2l-pytorch-0-longer'])test.skipIf(!existsSync(`${samples}/${id}.before.pdf`))(`saved r21 fixture: ${id}`,async()=>{
 const spec=JSON.parse(await readFile(`${samples}/${id}.edit.json`,'utf8'));
 const before=await readFile(`${samples}/${id}.before.pdf`),doc=await PDFDocument.load(before);
 const result=await applyContentTextEdits(doc.getPage(0),[spec.overlay],{loadFont,stage5Type1:spec.stage5Type1,stage5Reflow:spec.stage5Reflow,stage5Substitute:spec.stage5Substitute});
 expect(result.outcomes[0]?.mode).toBe('retypeset');
 const after=await doc.save(),native=openPdfium(resolve('vendor/pdfium/linux-x64/lib/libpdfium.so'));
 try{
  const a=native.inspectPage(before),b=native.inspectPage(after),m=result.outcomes[0]!.retypeset!;
  if(id.startsWith('gsa')){
   const row=(p:typeof a)=>p.glyphs.filter(g=>Math.abs(g.origin[1]-445.3)<.1).map(g=>[g.text,...g.origin]);
   expect(row(a).length).toBeGreaterThan(0);expect(row(b).map(g=>g[0])).toEqual(row(a).map(g=>g[0]));expect(row(b)[0]).toEqual(row(a)[0]);expect(m.unchangedLineDriftPt).toBe(0);
  }else{
   expect(m).toMatchObject({pushed:true,overflowInkOverlap:false});
   const old=a.glyphs.find(g=>g.text==='R'&&Math.abs(g.origin[1]-550.2)<.1)!;
   const moved=b.glyphs.find(g=>g.text==='R'&&Math.abs(g.origin[0]-old.origin[0])<.01)!;
   expect(old.origin[1]-moved.origin[1]).toBeCloseTo(m.pushedDeltaPt,3);
   const wrap=b.glyphs.find(g=>g.text==='习')!;expect(wrap.inkBox[1]).toBeGreaterThan(moved.inkBox[3]);
  }
  const dir='test-artifacts/r22-quality';await mkdir(dir,{recursive:true});await writeFile(`${dir}/${id}.after.pdf`,after);
  await writeFile(`${dir}/${id}.json`,JSON.stringify({command:'bun test src/pdf/export/contentText/retypesetQuality.test.ts',outcome:result.outcomes,old:a.glyphs,after:b.glyphs},null,2));
 }finally{native.close();}
});

// Additional failure cases, before extending emission: unchanged source lines
// inside the paragraph must also push; quote-state effects and scaled CTMs
// must survive; moving images cannot drag a separate column's image along.
test('a pushed unchanged paragraph line preserves x/string and reports its baseline delta',async()=>{
 const f=await fixture('BT /F1 10 Tf 14 TL 50 150 Td (ABCDE) Tj 0 -14 Td (FGHIJ) Tj ET');
 const before=read(f.page),m=await edit(f.page,overlay({text:'ABCDEFGH',coverRects:[{x:49,y:148,w:32,h:13}]}));
 expect(m).toMatchObject({pushed:true,pushedDeltaPt:14,unchangedLineDriftPt:14,overflowInkOverlap:false});
 expect(read(f.page).stream).toContain('(FGHIJ) Tj');
 expect(positions(read(f.page).glyphs.filter(g=>g.y===122))).toEqual(positions(before.glyphs.filter(g=>g.y===136)).map(g=>[...g.slice(0,4),122]));
});

for(const quote of ["(Release) '",'1 0.2 (Release) "'])test(`push retains persistent quote parameters and a scaled CTM (${quote})`,async()=>{
 const f=await fixture(title+`q 2 0 0 2 0 0 cm BT /F1 5 Tf 7 TL 27.5 67 Td ${quote} (Z) Tj ET Q`);
 const before=read(f.page),m=await edit(f.page,longer()),after=read(f.page);
 expect(m).toMatchObject({pushed:true,pushedDeltaPt:24,overflowInkOverlap:false});
 expect(positions(after.glyphs.filter(g=>g.state.fontSize===5))).toEqual(positions(before.glyphs.filter(g=>g.state.fontSize===5)).map(g=>[...g.slice(0,4),(g[4] as number)-24]));
});

test('in-column image moves by the text delta while another-column image stays put',async()=>{
 const f=await fixture(title+release+'q 20 0 0 10 80 90 cm /Image Do Q q 20 0 0 10 220 90 cm /Image Do Q');
 const image=f.doc.context.register(f.doc.context.stream(Uint8Array.of(0),{Type:'XObject',Subtype:'Image',Width:1,Height:1,ColorSpace:'DeviceGray',BitsPerComponent:8}));
 f.page.node.Resources()!.set(PDFName.of('XObject'),f.doc.context.obj({Image:image}));
 const before=await f.doc.save(),m=await edit(f.page,longer()),after=await f.doc.save();expect(m.pushed).toBe(true);
 const native=openPdfium(resolve('vendor/pdfium/linux-x64/lib/libpdfium.so'));
 try{
  const a=native.inspectPage(before,0,true),b=native.inspectPage(after,0,true),pixel=(p:typeof a,x:number,y:number)=>p.pixels![(Math.floor((p.height-y)*2)*600+Math.floor(x*2))*4]!;
  expect(pixel(a,85,95)).toBe(0);expect(pixel(b,85,95)).toBe(255);expect(pixel(b,85,71)).toBe(0);
  expect(pixel(a,225,95)).toBe(0);expect(pixel(b,225,95)).toBe(0);
 }finally{native.close();}
});

for(const vertical of ['Identity-V','dictionary','cmap'])test(`vertical source is refused precisely without laying it sideways (${vertical})`,async()=>{
 const f=await fixture();
 const raw=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict);
 if(vertical==='Identity-V'){
  raw.set(PDFName.of('Subtype'),PDFName.of('Type0'));raw.set(PDFName.of('Encoding'),PDFName.of('Identity-V'));
  raw.set(PDFName.of('DescendantFonts'),f.doc.context.obj([{Type:'Font',Subtype:'CIDFontType2',BaseFont:'Courier',DW:600}]));
 }else if(vertical==='dictionary')raw.set(PDFName.of('WMode'),f.doc.context.obj(1));
 else raw.set(PDFName.of('Encoding'),f.doc.context.register(f.doc.context.stream(new TextEncoder().encode('/WMode 1 def'))));
 const before=inspectRunPage(f.page),outcomes=new Map<string,ContentTextOutcome>();
 await applyRetypesets(f.page,[overlay()],outcomes,new Set(),{loadFont});
 expect(outcomes.get('edit')).toMatchObject({mode:'unsupported',detail:expect.stringContaining('vertical-writing')});expect(inspectRunPage(f.page)).toEqual(before);
});

// A successful transaction must not hide new wrap ink in an inherited clip.
// If that clip cannot be enlarged safely, preserve the original transaction.
for(const clip of ['50 140 120 40 re W n','50 140 m 170 140 l 110 190 l h W n'])test(`new wrap outside an inherited clip fails visibly (${clip})`,async()=>{
 const f=await fixture(`q ${clip} ${title} Q`),before=inspectRunPage(f.page),outcomes=new Map<string,ContentTextOutcome>();
 await applyRetypesets(f.page,[longer()],outcomes,new Set(),{loadFont});
 expect(outcomes.get('edit')).toMatchObject({mode:'unsupported',reason:'unsupported-unwritable',detail:expect.stringContaining('source-clip')});
 expect(inspectRunPage(f.page)).toEqual(before);
});

test('two separately changed blocks report overlap with each other and keep the intervening source line',async()=>{
 const f=await fixture('BT /F1 10 Tf 14 TL 50 150 Td (ABCDE) Tj 0 -14 Td (FGHIJ) Tj 0 -14 Td (KLMNO) Tj ET');
 const outcomes=new Map<string,ContentTextOutcome>(),a=overlay({text:'ABCDEFGHIJKLM',coverRects:[{x:49,y:148,w:32,h:13}]}),b=overlay({id:'second',originalText:'KLMNO',text:'PQRST',coverRects:[{x:49,y:120,w:32,h:13}]});
 await applyRetypesets(f.page,[a,b],outcomes,new Set(),{loadFont});
 expect(outcomes.get('edit')).toMatchObject({mode:'retypeset',retypeset:{pushed:false,overflowInkOverlap:true,pushReason:'push-blocked-by-multiple-changed-blocks'}});
 expect(read(f.page).stream).toContain('(FGHIJ) Tj');
 expect(read(f.page).glyphs.filter(g=>g.y===136).map(g=>g.text).join('')).toContain('FGHIJ');
});
