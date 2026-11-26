import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {fixture,overlay} from './fixtures.test-support';
import {applyRetypesets} from './retypeset';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {readRetypesetSource} from './retypesetSource';
import {RETYPESET_ENVELOPE_FLOOR} from './retypesetEnvelope';
import type {ContentTextOutcome} from './outcomes';

// r31 P2-A failure list, written before the envelope change. A one-line
// block with no aligned neighbour line has no witnessed measure, so the only
// space it may claim is its own ink band. Ways this can fail:
// (1) the line still gets no envelope and keeps overlapping the rule below;
// (2) the ladder re-breaks or adds a row, painting below the line's band;
// (3) compaction claims width past the line's own ink (a neighbour column,
//     a header margin);
// (4) stationary ink inside the band (an underline) is painted over;
// (5) size or leading goes below the .85 floor to force a fit;
// (6) a refusal no longer restores the exact prior output;
// (7) a multi-line paragraph switches to the own-band envelope instead of
//     its paragraph measure, changing an existing fit.
const rule='0.4 w 10 127 m 290 127 l S ';
const under='BT /F1 10 Tf 50 138 Td (EEEE FFFF GGGG HHHH) Tj ET 0.4 w 50 136.5 m 164 136.5 l S '+rule+'BT /F1 10 Tf 50 105 Td (ZZZZ ZZ) Tj ET';
const lone='BT /F1 10 Tf 50 138 Td (EEEE FFFF GGGG HHHH) Tj ET '+rule+'BT /F1 10 Tf 50 105 Td (ZZZZ ZZ) Tj ET';
const para='BT /F1 10 Tf 12 TL 50 150 Td (AAAA BBBB CCCC DDDD) Tj T* (EEEE FFFF GGGG HHHH) Tj ET '+rule+'BT /F1 10 Tf 50 105 Td (FOLLOWING) Tj ET ';
const edit=(suffix:string)=>overlay({text:'EEEE FFFF GGGG HHHH'+suffix,originalText:'EEEE FFFF GGGG HHHH',fontSize:10,coverRects:[{x:49,y:136,w:116,h:11}]});
async function run(stream:string,suffix:string){
 const f=await fixture(stream),outcomes=new Map<string,ContentTextOutcome>();
 await applyRetypesets(f.page,[edit(suffix)],outcomes,new Set(),{});
 const s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);
 const glyphs=readRetypesetSource(f.page,tokenizeContentStream(s.bytes)).glyphs;
 return{m:outcomes.get('edit')!.retypeset!,glyphs,digest:createHash('sha256').update(s.bytes).digest('hex').slice(0,16)};
}
// Source line: 19 Courier glyphs at 10 pt from x=50 on baseline 138. Its
// ink (the font box, as the paragraph envelope also measures it) spans
// x 49.76..165.16 and y 135.49..146.06.
const changed=(r:Awaited<ReturnType<typeof run>>)=>r.glyphs.filter(g=>g.y>130&&g.y<145);
const others=(r:Awaited<ReturnType<typeof run>>)=>r.glyphs.filter(g=>!(g.y>130&&g.y<145)).map(g=>[g.text,g.x,g.y,g.state.fontSize]);
function insideOwnBand(r:Awaited<ReturnType<typeof run>>){
 const e=r.m.envelopeFit!.envelope;
 // Never wider than the line's ink, never down toward the rule or up past the line.
 expect(e.x).toBeGreaterThanOrEqual(49.75);expect(e.x+e.w).toBeLessThanOrEqual(165.17);
 expect(e.y).toBeGreaterThanOrEqual(135.48);expect(e.y+e.h).toBeLessThanOrEqual(146.07);
}

test('a one-line block without an aligned neighbour compacts within its own band',async()=>{
 const base=await run(lone,''),r=await run(lone,'I');
 expect(r.m).toMatchObject({pushed:false,overflowInkOverlap:false,fitStrategy:'fit-envelope',lineCount:1});
 expect(r.m.envelopeFit).toMatchObject({basis:'own-band',step:'tracking',sizeScale:1});
 insideOwnBand(r);
 expect(changed(r).map(g=>g.text).join('')).toBe('EEEE FFFF GGGG HHHHI');
 expect(changed(r).every(g=>g.y===138&&g.state.fontSize===10)).toBe(true);
 expect(others(r)).toEqual(others(base));
});

test('own-band shrink stays on the line and at or above the .85 floor',async()=>{
 const r=await run(lone,' II');
 expect(r.m).toMatchObject({overflowInkOverlap:false,fitStrategy:'fit-envelope',lineCount:1});
 expect(r.m.envelopeFit).toMatchObject({basis:'own-band',step:'shrink'});
 expect(r.m.envelopeFit!.sizeScale).toBeGreaterThanOrEqual(RETYPESET_ENVELOPE_FLOOR);expect(r.m.envelopeFit!.sizeScale).toBeLessThan(1);
 insideOwnBand(r);
 expect(changed(r).every(g=>g.y===138&&g.state.fontSize>=8.5&&g.state.fontSize<10)).toBe(true);
});

// Digests were taken from the pipeline before the own-band envelope existed.
const refusals:[string,string,string,string][]=[
 // A re-break would place IIIIII on a new row: the ladder may not add one.
 ['growth that needs a second row',lone,' IIIIII','b0117bb5b61e5b94'],
 // Fits only below .85 of the size.
 ['growth past the floor',lone,' IIII','88cccd6178f3ee5a'],
 // An underline inside the band: any compaction still paints over it.
 ['tight obstruction in the band',under,'I','75e1a2a66828ebec'],
];
for(const [name,stream,suffix,digest]of refusals)test(`own band refuses and restores the prior output: ${name}`,async()=>{
 const r=await run(stream,suffix);
 expect(r.m).toMatchObject({pushed:false,overflowInkOverlap:true});expect(r.m.fitStrategy).toBeUndefined();
 expect(r.digest).toBe(digest);
});

// A 20 pt title (x 50..170) gains one letter under a rule it cannot push
// past. Before r31 these rows kept overlapping the rule.
const title='BT /F1 20 Tf 24 TL 50 150 Td (ABCDEFGHIJ) Tj ET ',body='BT /F1 10 Tf 50 105 Td (FOLLOWING) Tj ET ';
for(const [name,stream]of [
 ['full-width rule',title+rule+body],
 ['rule beside a foreign column',title+'0.4 w 47 127 m 180 127 l S '+body+'BT /F1 10 Tf 176 105 Td (FOREIGN) Tj ET'],
])test(`a one-line title that cannot push compacts in place: ${name}`,async()=>{
 const f=await fixture(stream),before=readRetypesetSource(f.page,tokenizeContentStream((inspectRunPage(f.page) as {bytes:Uint8Array}).bytes)).glyphs;
 const outcomes=new Map<string,ContentTextOutcome>();
 await applyRetypesets(f.page,[overlay({text:'ABCDEFGHIJK',originalText:'ABCDEFGHIJ',fontSize:20,coverRects:[{x:49,y:147,w:122,h:24}]})],outcomes,new Set(),{});
 const m=outcomes.get('edit')!.retypeset!,s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);
 const after=readRetypesetSource(f.page,tokenizeContentStream(s.bytes)).glyphs,big=after.filter(g=>g.state.fontSize>10);
 expect(m).toMatchObject({pushed:false,overflowInkOverlap:false,fitStrategy:'fit-envelope',lineCount:1});
 expect(m.envelopeFit).toMatchObject({basis:'own-band'});expect(m.envelopeFit!.sizeScale).toBeGreaterThanOrEqual(RETYPESET_ENVELOPE_FLOOR);
 // One row on the source baseline; nothing past the title's own ink.
 expect(big.map(g=>g.text).join('')).toBe('ABCDEFGHIJK');expect(big.every(g=>g.y===150&&g.state.fontSize>=17)).toBe(true);
 const e=m.envelopeFit!.envelope;expect(e.x+e.w).toBeLessThanOrEqual(173);expect(e.y).toBeGreaterThan(140);
 const small=(gs:typeof after)=>gs.filter(g=>g.state.fontSize===10).map(g=>[g.text,g.x,g.y]);
 expect(small(after)).toEqual(small(before));
});

test('a multi-line paragraph keeps its paragraph-measure envelope',async()=>{
 const envelope={x:49.760000000000005,y:127.29284271247461,w:115.40000000000002,h:30.767157287525393};
 for(const [suffix,step,digest]of [['I','tracking','a31adbbeea8472b1'],[' II','shrink','3ce36b049021aa48']]as const){
  const r=await run(para,suffix);
  expect(r.m).toMatchObject({fitStrategy:'fit-envelope',lineCount:2});
  expect(r.m.envelopeFit).toMatchObject({envelope,step});expect(r.m.envelopeFit!.basis).toBeUndefined();
  expect(r.digest).toBe(digest);
 }
});
