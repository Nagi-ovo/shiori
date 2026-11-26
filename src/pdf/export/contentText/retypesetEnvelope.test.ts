import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {PDFName} from 'pdf-lib';
import {fixture,overlay} from './fixtures.test-support';
import {applyRetypesets} from './retypeset';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {readRetypesetSource} from './retypesetSource';
import {retypesetEnvelopeLadder,RETYPESET_ENVELOPE_FLOOR} from './retypesetEnvelope';
import type {ContentTextOutcome} from './outcomes';

// Failure list (STATUS.md, r26): a column paragraph that grows a row into a
// full-width rule has no push; the ladder must (1) prefer tracking over size,
// (2) shrink only to the .85 floor, (3) use tighter leading only when its rows
// stay apart, (4) take a one-line block's measure only from an aligned
// neighbour (without one it compacts in its own band: r31 P2-A,
// retypesetEnvelopeOwnBand.test.ts),
// (5) never paint over furniture in the gap, (6) leave every unresolved row
// byte-identical to the pipeline without the ladder.
const rule='0.4 w 10 127 m 290 127 l S ',body='BT /F1 10 Tf 50 105 Td (FOLLOWING) Tj ET ';
const para=(tl=12)=>`BT /F1 10 Tf ${tl} TL 50 150 Td (AAAA BBBB CCCC DDDD) Tj T* (EEEE FFFF GGGG HHHH) Tj ET `;
const second=(suffix:string,y=138)=>overlay({text:'EEEE FFFF GGGG HHHH'+suffix,originalText:'EEEE FFFF GGGG HHHH',fontSize:10,coverRects:[{x:49,y:y-2,w:116,h:11}]});
async function run(stream:string,e:ReturnType<typeof overlay>,image=false){
 const f=await fixture(stream);
 if(image){const ref=f.doc.context.register(f.doc.context.stream(Uint8Array.of(0),{Type:'XObject',Subtype:'Image',Width:1,Height:1,ColorSpace:'DeviceGray',BitsPerComponent:8}));f.page.node.Resources()!.set(PDFName.of('XObject'),f.doc.context.obj({Image:ref}));}
 const outcomes=new Map<string,ContentTextOutcome>();await applyRetypesets(f.page,[e],outcomes,new Set(),{});
 const s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);
 const glyphs=readRetypesetSource(f.page,tokenizeContentStream(s.bytes)).glyphs;
 return {m:outcomes.get(e.id)!.retypeset!,glyphs,digest:createHash('sha256').update(s.bytes).digest('hex').slice(0,16)};
}
const fixed=(gs:Awaited<ReturnType<typeof run>>['glyphs'])=>gs.filter(g=>g.y>145||g.y<110).map(g=>[g.text,g.x,g.y,g.state.fontSize]);
const changed=(gs:Awaited<ReturnType<typeof run>>['glyphs'])=>gs.filter(g=>g.y<145&&g.y>110);

test('ladder order is re-break, tracking, leading, shrink, within frame-tightening bounds',()=>{
 const steps=retypesetEnvelopeLadder(),order=['rebreak','tracking','leading','shrink'];
 expect(steps.map(s=>order.indexOf(s.step))).toEqual(steps.map(s=>order.indexOf(s.step)).toSorted((a,b)=>a-b));
 expect(steps[0]!.adjustment).toEqual({sizeScale:1,trackingEm:0,wordReductionEm:0});
 for(const {adjustment:a}of steps){
  expect(a.sizeScale).toBeGreaterThanOrEqual(RETYPESET_ENVELOPE_FLOOR);expect(a.leadingScale??a.sizeScale).toBeGreaterThanOrEqual(RETYPESET_ENVELOPE_FLOOR);
  expect(a.trackingEm).toBeLessThanOrEqual(.03);expect(a.wordReductionEm).toBeLessThanOrEqual(.03);
 }
 expect(steps.at(-1)!.adjustment.sizeScale).toBe(RETYPESET_ENVELOPE_FLOOR);
});

test('a column paragraph blocked by a full-width rule fits by tracking before any size change',async()=>{
 const base=await run(para()+rule+body,second('',138)),{m,glyphs}=await run(para()+rule+body,second('I'));
 expect(m).toMatchObject({pushed:false,overflowInkOverlap:false,fitStrategy:'fit-envelope',lineCount:2});
 expect(m.envelopeFit).toMatchObject({step:'tracking',sizeScale:1});
 expect(changed(glyphs).every(g=>g.state.fontSize===10&&g.y===138)).toBe(true);
 expect(changed(glyphs).map(g=>g.text).join('')).toBe('EEEE FFFF GGGG HHHHI');
 expect(fixed(glyphs)).toEqual(fixed(base.glyphs));
});

test('shrink is used only after tracking fails and stays at or above the floor',async()=>{
 const {m,glyphs}=await run(para()+rule+body,second(' I'));
 expect(m).toMatchObject({pushed:false,overflowInkOverlap:false,fitStrategy:'fit-envelope'});
 expect(m.envelopeFit!.step).toBe('shrink');expect(m.envelopeFit!.sizeScale).toBeGreaterThanOrEqual(.85);
 const sizes=changed(glyphs).map(g=>g.state.fontSize);
 expect(sizes.every(s=>s<10&&s>=8.5)).toBe(true);expect(changed(glyphs).every(g=>g.y===138)).toBe(true);
 // Painted ink stays inside the envelope, which ends above the rule.
 expect(m.envelopeFit!.envelope.y).toBeGreaterThan(127);
});

test('tighter leading fits a wrapped row into partial whitespace when rows stay apart',async()=>{
 const {m,glyphs}=await run(para(14)+'0.4 w 10 121 m 290 121 l S '+body,second(' IIIIII',136));
 expect(m).toMatchObject({pushed:false,overflowInkOverlap:false,fitStrategy:'fit-envelope'});
 expect(m.envelopeFit).toMatchObject({step:'leading',sizeScale:1});
 expect(m.envelopeFit!.leadingScale).toBeLessThan(1);expect(m.envelopeFit!.leadingScale).toBeGreaterThanOrEqual(.85);
 const wrapped=glyphs.filter(g=>g.text==='I'&&g.y<136&&g.y>121);
 expect(wrapped.length).toBe(6);expect(wrapped.every(g=>g.state.fontSize===10)).toBe(true);
});

test('furniture painted in the gap below the paragraph blocks every rung',async()=>{
 const stream=para(14)+'0.4 w 10 121 m 290 121 l S q 10 0 0 3 58 122 cm /Image Do Q '+body;
 const {m,digest}=await run(stream,second(' IIIIII',136),true);
 expect(m).toMatchObject({pushed:false,overflowInkOverlap:true});expect(m.fitStrategy).toBeUndefined();
 expect(digest).toBe('39a2dcef2489a5b9');
});

test('a one-line block fits when an aligned neighbour evidences its measure',async()=>{
 const stream='BT /F1 10 Tf 50 138 Td (EEEE FFFF GGGG HHHH) Tj ET '+rule+'BT /F1 10 Tf 50 105 Td (ZZZZ ZZZZ ZZZZ ZZZZ) Tj ET';
 const {m}=await run(stream,second('I'));
 expect(m).toMatchObject({pushed:false,overflowInkOverlap:false,fitStrategy:'fit-envelope'});
});

