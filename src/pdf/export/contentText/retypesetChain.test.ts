import {afterEach,expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {PDFName} from 'pdf-lib';
import {fixture,overlay} from './fixtures.test-support';
import {applyRetypesets} from './retypeset';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {readRetypesetSource} from './retypesetSource';
import {retypesetPaintedInk} from './retypesetInk';
import {retypesetChainShadow,sameRetypesetPush} from './retypesetChain';
import {chainScenarios,runChainScenario,title} from './retypesetChain.scenarios.test-support';
import {exportPdf} from '../exportPdf';
import {openPdfium} from '../../../../scripts/pdf-inplace/nativePdfium';
import type {ContentTextOverlay,PageModel} from '../../model/types';
import type {Type1Options} from '../fontCoverage/type1Support';
import type {ContentTextOutcome} from './outcomes';

// Failure list (STATUS.md, r27), written before the chain:
// 1. an existing successful push re-planned under the chain rules is not the
//    same push (moved set, delta, byte patches, regions);
// 2. a 0x0 or outline-less box refuses a push that already succeeds;
// 3. a chain moves part of its followers (one moves, the next is blocked);
// 4. a chain moves glyphs horizontally, or moves a row sharing x with a
//    foreign column;
// 5. furniture moves with the chain: a running-head rule, or any row
//    landing in the page foot;
// 6. a rotated glyph's painted envelope fails to contain its native ink;
// 7. a refused chain changes the output of today's failure row;
// 8. a new rescue moves a unit that paints nothing (no native evidence of
//    its destination exists).
// Digests of today's failure output were taken from the pipeline before
// the chain existed (same scenarios, same fixture). r31: the four refused
// scenarios grow the title beyond its own ink band (P2-A); their digests
// were re-taken from the current pipeline with the chain step disabled.
const before:Record<string,string>={
 'wide-row':'9da2b89f57a084e5',
 'wide-row-blocked':'9bfaf62b89b64f69',
 'wide-row-foreign':'f5e00eba01565cda',
 'running-head':'8b7fd60781a12d46',
 'page-foot':'3de1345dd5411b21',
 'wide-row-hidden':'bc22fa5d7d3cca8a',
 'rotated-margin':'ed66622eb6d1c430',
};
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex').slice(0,16);
type Glyphs=Awaited<ReturnType<typeof runChainScenario>>['after'];
const where=(gs:Glyphs)=>gs.filter(g=>g.state.fontSize!==20).map(g=>[g.text,g.x,g.y]);
afterEach(()=>{retypesetChainShadow.observe=undefined;});

test('a full-measure row and the column text below it move together by one delta, vertically only',async()=>{
 const {m,before:old,after}=await runChainScenario('wide-row');
 expect(m).toMatchObject({pushed:true,pushedDeltaPt:24,overflowInkOverlap:false,fitStrategy:'chain-push'});
 // Every follower moves by the same delta and keeps its x.
 expect(where(after)).toEqual(where(old).map(([t,x,y])=>[t,x,(y as number)-24]));
 expect(m.pushedRegions.some(r=>r.before.x<30&&r.before.w>150)).toBe(true);
});

test('a chain whose last follower is blocked moves nothing and keeps the existing output',async()=>{
 const r=await runChainScenario('wide-row-blocked');
 expect(r.m).toMatchObject({pushed:false,overflowInkOverlap:true});expect(r.m.fitStrategy).toBeUndefined();
 expect(r.m.pushReason).toStartWith('push-blocked-by-');
 expect(where(r.after)).toEqual(where(r.before));
 expect(digest(r.bytes)).toBe(before['wide-row-blocked']!);
});

test('a wider row sharing x with a foreign column stays a barrier; the foreign column never moves',async()=>{
 const r=await runChainScenario('wide-row-foreign');
 expect(r.m).toMatchObject({pushed:false,overflowInkOverlap:true});
 expect(where(r.after)).toEqual(where(r.before));
 expect(digest(r.bytes)).toBe(before['wide-row-foreign']!);
});

test('a rule under a running head is furniture even when it spans the measure',async()=>{
 const r=await runChainScenario('running-head');
 expect(r.m).toMatchObject({pushed:false,overflowInkOverlap:true});
 expect(digest(r.bytes)).toBe(before['running-head']!);
});

test('a rescue leaves invisible text in place and moves only painted followers',async()=>{
 const {m,before:old,after}=await runChainScenario('wide-row-hidden');
 expect(m).toMatchObject({pushed:true,pushedDeltaPt:24,overflowInkOverlap:false,fitStrategy:'chain-push'});
 expect(m.pushedRegions.every(r=>r.before.w>0&&r.before.h>0)).toBe(true);
 const hidden=(gs:Glyphs)=>where(gs.filter(g=>g.state.renderMode===3));
 expect(hidden(after)).toEqual(hidden(old));expect(hidden(old)).toHaveLength(6);
 const shown=(gs:Glyphs)=>where(gs.filter(g=>g.state.renderMode!==3));
 expect(shown(after)).toEqual(shown(old).map(([t,x,y])=>[t,x,(y as number)-24]));
});

test('a chain whose last row would land in the page foot moves nothing',async()=>{
 const r=await runChainScenario('page-foot');
 expect(r.m).toMatchObject({pushed:false,overflowInkOverlap:true});
 expect(where(r.after)).toEqual(where(r.before));
 expect(digest(r.bytes)).toBe(before['page-foot']!);
});

test('rotated margin glyphs obstruct by painted coverage, not the whole page',async()=>{
 const {m,before:old,after}=await runChainScenario('rotated-margin');
 expect(m).toMatchObject({pushed:true,pushedDeltaPt:24,overflowInkOverlap:false,fitStrategy:'chain-push'});
 const side=(gs:Glyphs)=>where(gs.filter(g=>g.state.fontSize===8));
 expect(side(after)).toEqual(side(old));
 const body=(gs:Glyphs)=>where(gs.filter(g=>g.state.fontSize===10));
 expect(body(after)).toEqual(body(old).map(([t,x,y])=>[t,x,(y as number)-24]));
});

test('every scenario that is refused is byte-identical to the output before the chain',async()=>{
 for(const name of Object.keys(chainScenarios)){
  const r=await runChainScenario(name);
  if(!r.m.pushed)expect(digest(r.bytes),name).toBe(before[name]!);
  else expect(digest(r.bytes),name).not.toBe(before[name]!);
 }
});

const library=resolve('vendor/pdfium/linux-x64/lib/libpdfium.so');
test.skipIf(!existsSync(library))('the painted envelope of a rotated glyph contains its native ink',async()=>{
 const f=await fixture(title+'BT /F1 8 Tf 0 1 -1 0 292 30 Tm (SIDE NOTE) Tj ET BT /F1 9 Tf .7 .7 -.7 .7 200 40 Tm (TILTED) Tj ET');
 const s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);
 const source=readRetypesetSource(f.page,tokenizeContentStream(s.bytes)),painted=retypesetPaintedInk(f.page,source.fonts);
 const native=openPdfium(library);
 try{
  const glyphs=native.inspectPage(await f.doc.save(),0,true).glyphs.filter(g=>g.fontSize<10&&g.text.trim());
  const ours=source.glyphs.filter(g=>g.state.fontSize<10&&g.text?.trim());
  expect(ours).toHaveLength(glyphs.length);
  for(const g of ours){
   const font=source.fonts.find(x=>x.resourceName===g.glyph.fontName)!,ink=painted(font,g.glyph.code,g.state,g.x,g.y)!;
   const n=glyphs.find(h=>h.text===g.text&&Math.hypot(h.origin[0]-g.x,h.origin[1]-g.y)<.01)!;
   expect(ink.known).toBe(true);expect(n).toBeDefined();
   const [l,b,r,t]=n.inkBox;
   expect(ink.box.x).toBeLessThanOrEqual(l!);expect(ink.box.y).toBeLessThanOrEqual(b!);
   expect(ink.box.x+ink.box.w).toBeGreaterThanOrEqual(r!);expect(ink.box.y+ink.box.h).toBeGreaterThanOrEqual(t!);
  }
 }finally{native.close();}
});

// Shadow: in-tree successful pushes re-planned under the chain rules. The
// observer only reports; output always comes from the existing push.
const body='BT /F1 10 Tf 50 105 Td (FOLLOWING) Tj ET ',other='BT /F1 10 Tf 220 105 Td (OTHER) Tj ET';
const outsiders='170 0 Td (OTHER) Tj T* (NEXT) Tj 0 -16 TD (LAST) Tj';
const pushes:{name:string;stream:string;image?:boolean;annot?:boolean;low?:boolean}[]=[
 {name:'rule',stream:title+'0.4 w 47 127 m 173 127 l S '+body+other},
 {name:'image',stream:title+'q 126 0 0 18 47 114 cm /Image Do Q '+body+other,image:true},
 {name:'indented-text',stream:title+'BT /F1 10 Tf 47 126 Td (WIDER COLUMN LINE HERE) Tj ET '+body+other},
 {name:'footer-gap',stream:title+'0.4 w 47 127 m 173 127 l S '+body+'BT /F1 10 Tf 50 40 Td (FOOTER) Tj ET'},
 {name:'annotation',stream:title+'0.4 w 47 127 m 173 127 l S '+body,annot:true},
 {name:'small-rule',stream:title+'0 g 80 132 3 .4 re f BT /F1 10 Tf 55 120 Td (Rel) Tj (ease) Tj ET BT /F1 10 Tf 220 120 Td (OTHER) Tj ET'},
 // 0x0 boxes: invisible text moves with the column; a space has no area.
 {name:'invisible',stream:'BT /F1 20 Tf 16 TL 50 118 Td (ABCDEFGHIJ) Tj ET BT /F1 10 Tf 3 Tr 1 .05 .2 1 50 108 Tm (HIDE) Tj 0 Tr 1 0 0 1 50 100 Tm (AB) Tj (CD) Tj ET',low:true},
 ...([['chained','BT /F1 10 Tf 50 100 Td (AB) Tj (CD) Tj ET'],
  ['clip','q 45 70 130 50 re W n BT /F1 10 Tf 50 100 Td (AB) Tj (CD) Tj ET Q'],
  ['tj','BT /F1 10 Tf 50 100 Td [-200 () -100 (AB) 80 (C) -50 (D) 40] TJ (EF) Tj ET'],
  ['quote',`BT /F1 10 Tf 16 TL 50 116 Td 2 .5 (A B) " (CD) Tj ${outsiders} ET`],
  ['single-quote',`BT /F1 10 Tf 16 TL 50 116 Td (AB) ' (CD) Tj ${outsiders} ET`],
  ['ctm','q 2 0 .4 2 0 0 cm BT /F1 5 Tf 1 Tc 2 Tw 80 Tz 2 Ts .5 0 -.2 1 15 50 Tm (AB) Tj [(C) -50 (D)] TJ ET Q']] as const)
  .map(([name,s])=>({name,stream:`BT /F1 20 Tf 16 TL 50 118 Td (ABCDEFGHIJ) Tj ET ${s}`,low:true})),
];
for(const c of pushes)test(`shadow: the chain rules re-plan the existing ${c.name} push identically`,async()=>{
 const f=await fixture(c.stream);
 if(c.image){const ref=f.doc.context.register(f.doc.context.stream(Uint8Array.of(0),{Type:'XObject',Subtype:'Image',Width:1,Height:1,ColorSpace:'DeviceGray',BitsPerComponent:8}));f.page.node.Resources()!.set(PDFName.of('XObject'),f.doc.context.obj({Image:ref}));}
 if(c.annot)f.page.node.set(PDFName.of('Annots'),f.doc.context.obj([{Type:'Annot',Subtype:'Link',Rect:[220,120,260,145]}]));
 const seen:boolean[]=[];retypesetChainShadow.observe=(existing,chain)=>{if(existing.pushed)seen.push(sameRetypesetPush(existing,chain));};
 const e=overlay({text:'ABCDEFGHIJK',originalText:'ABCDEFGHIJ',fontSize:20,coverRects:[{x:49,y:c.low?115:147,w:122,h:24}]});
 const outcomes=new Map<string,ContentTextOutcome>();await applyRetypesets(f.page,[e],outcomes,new Set(),{});
 const m=outcomes.get(e.id)!.retypeset!;
 expect(m.pushed).toBe(true);expect(m.fitStrategy).toBeUndefined();
 expect(seen).toEqual([true]);
});

const samples=process.env.RETYPESET_PUSH_R22_SAMPLES??'test-artifacts/pdf-corpus-r22/samples',sample='arxiv-2611.17030-0-overflow';
test.skipIf(!existsSync(`${samples}/${sample}.before.pdf`))('shadow: the saved official 17030 push re-plans identically under the chain rules',async()=>{
 const spec=JSON.parse(await readFile(`${samples}/${sample}.edit.json`,'utf8')) as {page:PageModel;overlay:ContentTextOverlay;stage5Type1:Type1Options;stage5Reflow:boolean;stage5Substitute:boolean};
 const seen:boolean[]=[];retypesetChainShadow.observe=(existing,chain)=>{if(existing.pushed)seen.push(sameRetypesetPush(existing,chain));};
 const result=await exportPdf(await readFile(`${samples}/${sample}.before.pdf`),{pages:[spec.page],overlays:[spec.overlay]},{mode:'flatten',stage5Type1:spec.stage5Type1,stage5Reflow:spec.stage5Reflow,stage5Substitute:spec.stage5Substitute,
  inPlaceFallback:{loadFont:name=>readFile(name.startsWith('Noto')?`src/assets/fonts/${name}`:`node_modules/@docx-editor.dev/fonts/assets/${name}`)}});
 expect(result.contentTextOutcomes![0]!).toMatchObject({mode:'retypeset',retypeset:{pushed:true}});
 expect(seen).toEqual([true]);
},60000);
