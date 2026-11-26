import {expect,test} from 'bun:test';
import {PDFName} from 'pdf-lib';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fixture,overlay} from './fixtures.test-support';
import {applyRetypesets} from './retypeset';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {readRetypesetSource} from './retypesetSource';
import {openPdfium} from '../../../../scripts/pdf-inplace/nativePdfium';
import {compareRetypesetNativePages} from '../../../../scripts/pdf-corpus/retypesetOracle';
import type {ContentTextOutcome} from './outcomes';

// Failure list recorded in STATUS.md before these production-path regressions.
const title='BT /F1 20 Tf 24 TL 50 150 Td (ABCDEFGHIJ) Tj ET ';
const body='BT /F1 10 Tf 50 105 Td (FOLLOWING) Tj ET ';
const longer=(text='ABCDEFGHIJK')=>overlay({text,originalText:'ABCDEFGHIJ',fontSize:20,coverRects:[{x:49,y:147,w:122,h:24}]});
// r31: one letter more fits the title's own ink band (P2-A, retypesetEnvelopeOwnBand.test.ts).
// Three more letters need .83 of the size, below the .85 floor, so the
// push refusal below stays the outcome under test.
const beyondOwnBand=()=>longer('ABCDEFGHIJKLM');
function glyphs(page:Parameters<typeof inspectRunPage>[0]){
 const s=inspectRunPage(page);if(!s.ok)throw Error(s.reason);
 return readRetypesetSource(page,tokenizeContentStream(s.bytes)).glyphs;
}
async function edit(f:Awaited<ReturnType<typeof fixture>>,e=longer()){
 const outcomes=new Map<string,ContentTextOutcome>();await applyRetypesets(f.page,[e],outcomes,new Set(),{});
 expect(outcomes.get(e.id)?.mode).toBe('retypeset');return outcomes.get(e.id)!.retypeset!;
}
function image(f:Awaited<ReturnType<typeof fixture>>){
 const ref=f.doc.context.register(f.doc.context.stream(Uint8Array.of(0),{Type:'XObject',Subtype:'Image',Width:1,Height:1,ColorSpace:'DeviceGray',BitsPerComponent:8}));
 f.page.node.Resources()!.set(PDFName.of('XObject'),f.doc.context.obj({Image:ref}));
}
async function artifact(name:string,f:Awaited<ReturnType<typeof fixture>>,before:Uint8Array,m:unknown){
 const dir='test-artifacts/r23-pushfit';await mkdir(dir,{recursive:true});
 const after=await f.doc.save(),native=openPdfium(resolve('vendor/pdfium/linux-x64/lib/libpdfium.so'));
 try{
  const a=native.inspectPage(before,0,true),b=native.inspectPage(after,0,true);
  await writeFile(`${dir}/${name}.before.pdf`,before);await writeFile(`${dir}/${name}.after.pdf`,after);
  await writeFile(`${dir}/${name}.json`,JSON.stringify({command:'bun test src/pdf/export/contentText/retypesetPushFit.test.ts',manifest:m,before:a.glyphs,after:b.glyphs},null,2));
  return {a,b};
 }finally{native.close();}
}
const origins=(gs:ReturnType<typeof glyphs>)=>gs.map(g=>[g.text,g.x,g.y,g.state.fontSize]);
for(const kind of ['rule','image','indented-text']as const)test(`slightly wider same-column ${kind} and following text share delta and clear overlap`,async()=>{
 const obstacle=kind==='rule'?'0.4 w 47 127 m 173 127 l S ':kind==='image'?'q 126 0 0 18 47 114 cm /Image Do Q ':'BT /F1 10 Tf 47 126 Td (WIDER COLUMN LINE HERE) Tj ET ';
 const f=await fixture(title+obstacle+body+'BT /F1 10 Tf 220 105 Td (OTHER) Tj ET');if(kind==='image')image(f);
 const before=await f.doc.save(),old=glyphs(f.page),m=await edit(f);
 expect(m).toMatchObject({pushed:true,pushedDeltaPt:24,overflowInkOverlap:false});
 const now=glyphs(f.page);
 expect(origins(now.filter(g=>g.x>=220))).toEqual(origins(old.filter(g=>g.x>=220)));
 expect(origins(now.filter(g=>g.state.fontSize===10&&g.x<200))).toEqual(origins(old.filter(g=>g.state.fontSize===10&&g.x<200)).map(g=>[g[0],g[1],(g[2]as number)-24,g[3]]));
 if(kind!=='indented-text')expect(m.pushedRegions.some(r=>r.before.x<50&&r.before.w>120&&r.after.y===r.before.y-24)).toBe(true);
 const {b}=await artifact(kind,f,before,m);
 const wrap=b.glyphs.find(g=>g.text==='K')!,next=b.glyphs.find(g=>g.text==='F'&&g.fontSize===10)!;
 expect(wrap.inkBox[1]).toBeGreaterThan(next.inkBox[3]);
});

test('full-width rule remains a barrier; no partial push past it',async()=>{
 const f=await fixture(title+'0.4 w 10 127 m 290 127 l S '+body),before=await f.doc.save(),old=glyphs(f.page),m=await edit(f,beyondOwnBand());
 expect(m).toMatchObject({pushed:false,overflowInkOverlap:true});expect(m.pushReason).toStartWith('push-blocked-by-');
 expect(origins(glyphs(f.page).filter(g=>g.state.fontSize===10))).toEqual(origins(old.filter(g=>g.state.fontSize===10)));
 await artifact('full-width-rule',f,before,m);
});
for(const y of [8,181])test(`margin logo stays fixed at y=${y}`,async()=>{
 const source=title+body+`q 20 0 0 10 60 ${y} cm /Image Do Q `,f=await fixture(source);image(f);
 const before=await f.doc.save(),m=await edit(f);
 expect(m.pushedRegions.some(r=>r.before.y<20||r.before.y>180)).toBe(false);
 const {a,b}=await artifact(`logo-${y}`,f,before,m);
 const pixel=(p:typeof a,x:number,py:number)=>p.pixels![(Math.floor((p.height-py)*2)*600+Math.floor(x*2))*4]!;
 expect(pixel(a,65,y+5)).toBe(0);expect(pixel(b,65,y+5)).toBe(0);
});

for(const frame of ['cell','box','banner']as const)test(`${frame} keeps changed ink inside its frame and leaves following text fixed`,async()=>{
 const shape=frame==='cell'?'0.4 w 45 140 m 175 140 l S 45 174 m 175 174 l S 45 140 m 45 174 l S 175 140 m 175 174 l S ':frame==='box'?'0.4 w 45 140 130 34 re S ':'0.8 g 40 140 240 34 re f 0 g ';
 // More text in the banner is necessary because its actual measure is wider.
 const text=frame==='banner'?'ABCDEFGHIJKLMNOPQRS':'ABCDEFGHIJK';
 const f=await fixture(shape+title+body),before=await f.doc.save(),old=glyphs(f.page),m=await edit(f,longer(text));
 expect(m).toMatchObject({pushed:false,overflowInkOverlap:false,fitStrategy:'tighten-frame'});
 const now=glyphs(f.page),changed=now.filter(g=>g.state.fontSize>10);
 expect(changed.length).toBe(text.length);expect(changed.every(g=>g.state.fontSize>=17&&g.state.fontSize<=20)).toBe(true);
 expect(origins(now.filter(g=>g.state.fontSize===10))).toEqual(origins(old.filter(g=>g.state.fontSize===10)));
 const {a,b}=await artifact(frame,f,before,m);
 expect(compareRetypesetNativePages(a,b,longer(text),m).changedPixelsOutsideRetypesetMask).toBe(0);
 for(const g of b.glyphs.filter(g=>g.fontSize>10)){
  expect(g.inkBox[0]).toBeGreaterThanOrEqual(frame==='banner'?40:45);expect(g.inkBox[2]).toBeLessThanOrEqual(frame==='banner'?280:175);
  expect(g.inkBox[1]).toBeGreaterThanOrEqual(140);expect(g.inkBox[3]).toBeLessThanOrEqual(174);
 }
 // A frame-contained fit needs no grow-down mask; all outside-frame pixels stay identical.
 let outside=0;
 for(let i=0;i<a.pixels!.length;i+=4){const x=(i/4%600)/2,y=200-Math.floor(i/4/600)/2;
  if((x<40||x>280||y<140||y>174)&&a.pixels!.subarray(i,i+4).some((v,j)=>v!==b.pixels![i+j]))outside++;
 }
 expect(outside).toBe(0);
});

test('spacing is tried before shrinking size',async()=>{
 const f=await fixture('0.4 w 45 140 138 34 re S '+title+body),m=await edit(f);
 expect(m).toMatchObject({fitStrategy:'tighten-frame',pushed:false,overflowInkOverlap:false});
 expect(glyphs(f.page).filter(g=>g.state.fontSize>10).every(g=>g.state.fontSize===20)).toBe(true);
 expect(glyphs(f.page).some(g=>g.state.charSpacing<0)).toBe(true);
});

test('frame exhaustion retains overflow at the documented floor without pushing the table',async()=>{
 const f=await fixture('0.4 w 45 140 130 34 re S '+title+body),old=glyphs(f.page),m=await edit(f,longer('ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZ'));
 expect(m).toMatchObject({pushed:false,overflowInkOverlap:true});expect(m.pushReason).toBe('push-blocked-by-bounded-frame');
 expect(glyphs(f.page).filter(g=>g.state.fontSize>10).every(g=>g.state.fontSize>=17)).toBe(true);
 expect(origins(glyphs(f.page).filter(g=>g.state.fontSize===10))).toEqual(origins(old.filter(g=>g.state.fontSize===10)));
});

// A one-letter growth now compacts inside the title's own band instead.
test('ordinary column paragraph retains source size when neither a push nor its own band fits',async()=>{
 const f=await fixture(title+'0.4 w 10 127 m 290 127 l S '+body),m=await edit(f,beyondOwnBand());
 expect(glyphs(f.page).filter(g=>g.state.fontSize>10).every(g=>g.state.fontSize===20)).toBe(true);
 expect(m).toMatchObject({pushed:false,overflowInkOverlap:true});
});

// Real GSA covers have a filled banner plus its border inside a page clip.
// Their conservative stroke bbox covers the whole banner interior.
test('bounded background plus clipped border fits without treating its own paints as foreign ink',async()=>{
 const f=await fixture('0.8 g 40 140 140 34 re f 0 g q 0 0 300 200 re W n 0.4 w 40 140 140 34 re S Q '+title+body),before=await f.doc.save(),m=await edit(f);
 expect(m).toMatchObject({fitStrategy:'tighten-frame',pushed:false,overflowInkOverlap:false});
 expect(m.frameFit).toMatchObject({floor:.85,fits:true});
 const {b}=await artifact('clipped-frame-border',f,before,m);
 expect(b.glyphs.filter(g=>g.fontSize>10).every(g=>g.inkBox[1]>=140&&g.inkBox[3]<=174)).toBe(true);
});

test('frame fitting measures and emits the same state under a scaled CTM',async()=>{
 const f=await fixture('q 1.5 0 0 1 0 0 cm 0.4 w 45 140 130 34 re S '+title+body+'Q'),before=await f.doc.save();
 const m=await edit(f,{...longer(),coverRects:[{x:74,y:147,w:182,h:24}]});
 expect(m).toMatchObject({fitStrategy:'tighten-frame',pushed:false,overflowInkOverlap:false});
 const {b}=await artifact('scaled-frame',f,before,m);
 expect(b.glyphs.filter(g=>g.fontSize>10).every(g=>g.fontSize>=17&&g.inkBox[0]>=67.5&&g.inkBox[2]<=262.5)).toBe(true);
});

test('a wider rule cannot reach into an evidenced adjacent column',async()=>{
 const f=await fixture(title+'0.4 w 47 127 m 180 127 l S '+body+'BT /F1 10 Tf 176 105 Td (FOREIGN) Tj ET'),old=glyphs(f.page),m=await edit(f,beyondOwnBand());
 expect(m).toMatchObject({pushed:false,overflowInkOverlap:true});
 expect(origins(glyphs(f.page).filter(g=>g.state.fontSize===10))).toEqual(origins(old.filter(g=>g.state.fontSize===10)));
});

test('a gap that absorbs the delta ends the pushed block before a nearby footer',async()=>{
 const f=await fixture(title+'0.4 w 47 127 m 173 127 l S '+body+'BT /F1 10 Tf 50 40 Td (FOOTER) Tj ET'),old=glyphs(f.page),m=await edit(f);
 expect(m).toMatchObject({pushed:true,overflowInkOverlap:false});
 expect(origins(glyphs(f.page).filter(g=>g.y===40))).toEqual(origins(old.filter(g=>g.y===40)));
 expect(glyphs(f.page).filter(g=>g.y===81).map(g=>g.text).join('')).toBe('FOLLOWING');
});

test('a banner clipped to the page edge remains a fixed frame',async()=>{
 const f=await fixture('q 0 0 300 200 re W n 0.8 g -2 140 182 64 re f 0 g 0.4 w -2 140 182 64 re S Q '+title+body),m=await edit(f);
 expect(m).toMatchObject({fitStrategy:'tighten-frame',pushed:false,overflowInkOverlap:false});
 expect(m.frameFit?.frame.x).toBeGreaterThanOrEqual(0);expect(m.frameFit!.frame.y+m.frameFit!.frame.h).toBeLessThanOrEqual(200);
});

for(const filled of [true,false])test(`connected ${filled?'filled':'compound stroked'} rules bound a table cell`,async()=>{
 const frame=filled?'45 140 130 0.4 re f 45 174 130 0.4 re f 45 140 0.4 34.4 re f 175 140 0.4 34.4 re f ':'0.4 w 45 140 m 175 140 l 175 174 l 45 174 l h S ';
 const f=await fixture(frame+title+body),m=await edit(f);
 expect(m).toMatchObject({pushed:false,fitStrategy:'tighten-frame',overflowInkOverlap:false});
 expect(m.frameFit).toMatchObject({fits:true,floor:.85});
});

test('page-sized outline is furniture and does not license free-column font shrinking',async()=>{
 const f=await fixture('0.4 w 1 1 298 198 re S '+title+'0.4 w 10 127 m 290 127 l S '+body),m=await edit(f);
 expect(m).toMatchObject({pushed:false,overflowInkOverlap:true});expect(m.fitStrategy).toBeUndefined();
 expect(glyphs(f.page).filter(g=>g.state.fontSize>10).every(g=>g.state.fontSize===20)).toBe(true);
});

test('frame fitting respects a crop even when the source graphics clip is larger',async()=>{
 const f=await fixture('q 0 0 300 200 re W n 0.4 w 45 140 130 34 re S Q '+title+body);
 f.page.setCropBox(0,145,300,55);
 const m=await edit(f);
 expect(m.frameFit!.frame.y).toBeGreaterThanOrEqual(145);
 expect(m).toMatchObject({pushed:false,overflowInkOverlap:false,fitStrategy:'tighten-frame'});
});

test('an annotation wholly in another column cannot cut off this column flow',async()=>{
 const f=await fixture(title+'0.4 w 47 127 m 173 127 l S '+body);
 f.page.node.set(PDFName.of('Annots'),f.doc.context.obj([{Type:'Annot',Subtype:'Link',Rect:[220,120,260,145]}]));
 const m=await edit(f);
 expect(m).toMatchObject({pushed:true,overflowInkOverlap:false});
 expect(glyphs(f.page).filter(g=>g.y===81).map(g=>g.text).join('')).toBe('FOLLOWING');
});
