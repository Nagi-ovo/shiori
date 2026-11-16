import {expect,test} from 'bun:test';
import {PDFDict,PDFName} from 'pdf-lib';
import {type1RegionPage} from './reflowRegion.test-support';
import {inspectRunPage,resolveRunFonts} from '../contentStreamEdit/replaceRunPage';
import {planStreamReflow} from './reflowAuto';
import {compileReflowPlan} from './reflowCompile';
import {streamReflowEvidence} from './reflowEvidence';
import {overlay} from './fixtures.test-support';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {proveGlyphRegion} from './regionProof/glyphRegion';
import {queryOccupancy} from './regionProof/occupancy';

const first='BT /F1 10 Tf 14 TL 50 150 Td (AB AB AB ) Tj ET ';
const row=(text:string,y=136)=>`BT /F1 10 Tf 14 TL 50 ${y} Td ${text} ET `;
const edit=(x=50)=>overlay({originalText:'A',text:'AB AB',coverRects:[{x:x-.05,y:135.5,w:6.1,h:8}]});
async function fixture(stream:string){
 const f=await type1RegionPage(stream),s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);
 const fonts=resolveRunFonts(f.page);
 return {...f,s,fonts,plan:(x=50)=>planStreamReflow(f.page,s.bytes,fonts,edit(x))};
}
test('short region clears a neighbour 2 pt below the glyph ink rather than using em envelopes',async()=>{
 const f=await fixture(first+row('(AB ) Tj')+row('(AB) Tj',127)),p=f.plan();
 expect(p?.reflow?.layout.strategy).toBe('suffix-shift');if(!p?.reflow)throw Error('missing short-geometry plan');
 expect(p.reflow.proof.lineSlots.map(s=>s.baseline)).toEqual([136]);
 expect(p.reflow.proof.mask?.length).toBeGreaterThan(0);expect(p.reflow.proof.occupancyHash).toBeTruthy();
 expect(p.reflow.proof.mask!.every(b=>b.y>134)).toBe(true);
 expect(compileReflowPlan(f.s.bytes,f.fonts,p).ok).toBe(true);
});
for(const rise of [0,3])test(`a different-size prefix stays at its original origin (rise=${rise})`,async()=>{
 const f=await fixture(first+row(`/F1 6 Tf 1 Tc ${rise} Ts (B) Tj /F1 10 Tf 0 Tc 0 Ts (AB ) Tj`)),p=f.plan(54.6);
 expect(p?.reflow?.layout.strategy).toBe('suffix-shift');if(!p?.reflow)throw Error('missing prefix plan');
 const i=p.reflow.clusters.findIndex(t=>t.em===6);expect(i).toBeGreaterThanOrEqual(0);
 expect(p.reflow.layout.origins[i]).toEqual([50,136+rise]);
 expect(compileReflowPlan(f.s.bytes,f.fonts,p).ok).toBe(true);
});
for(const rise of [0,3])test(`moving a different-size suffix still refuses (rise=${rise})`,async()=>{
 const f=await fixture(first+row(`(A) Tj /F1 6 Tf ${rise} Ts (B) Tj /F1 10 Tf 0 Ts ( AB ) Tj`));
 expect(f.plan()).toBeNull();
});
test('white paint after the text occupies the destination analytically',async()=>{
 const f=await fixture(first+row('(AB ) Tj')+'1 g 70 135 5 8 re f');
 const target=tokenizeContentStream(f.s.bytes).findLastIndex(op=>op.operator==='Tj');
 const e=streamReflowEvidence(f.page,f.s.bytes,f.fonts,target);if(!e.ok)throw Error(e.detail);
 expect(e.proof.lineSlots[0]!.right).toBe(69);
 const origins=e.source.map(t=>[t.original!.x,t.original!.y] as [number,number]);origins[1]=[70,136];
 expect(proveGlyphRegion(e,e.proof,e.source,origins,[])).toBeNull();
 // M3 may wrap around the small white rectangle, but cannot use it as space.
 const p=f.plan();expect(p?.reflow?.layout.strategy).toBe('wrap');
 if(!p)throw Error('missing safe wrap');expect(compileReflowPlan(f.s.bytes,f.fonts,p).ok).toBe(true);
 const blocked=await fixture(first+row('(AB ) Tj')+'1 g 70 0 5 143 re f');
 expect(blocked.plan()).toBeNull();
});
test('paragraph spacing in one BT does not become a reflow slot',async()=>{
 const f=await fixture('BT /F1 10 Tf 14 TL 50 150 Td (AB AB AB ) Tj 0 -14 Td (AB ) Tj 0 -28 Td (AB AB AB ) Tj 0 -14 Td (AB ) Tj ET'),p=f.plan();
 expect(p?.reflow?.proof.lineSlots.map(s=>s.baseline)).toEqual([136]);
 if(!p)throw Error('missing first paragraph');expect(compileReflowPlan(f.s.bytes,f.fonts,p).ok).toBe(true);
});
test('a non-embedded font cannot enter the move or replacement set',async()=>{
 const f=await fixture(first+row('(AB ) Tj'));
 f.font.lookup(PDFName.of('FontDescriptor'),PDFDict).delete(PDFName.of('FontFile'));
 f.font.delete(PDFName.of('ToUnicode'));
 f.font.set(PDFName.of('Encoding'),PDFName.of('WinAnsiEncoding'));
 const fonts=resolveRunFonts(f.page);
 expect(fonts[0]!.unicodeByCode.get(65)).toBe('A');
 const target=tokenizeContentStream(f.s.bytes).findLastIndex(op=>op.operator==='Tj');
 const evidence=streamReflowEvidence(f.page,f.s.bytes,fonts,target);
 expect(evidence.ok).toBe(true);
 if(!evidence.ok)throw Error(evidence.detail);
 expect(evidence.occupancy.embeddedFonts.has(fonts[0]!.objectId)).toBe(false);
 const origins=evidence.source.map(t=>[t.original!.x+1,t.original!.y] as [number,number]);
 expect(proveGlyphRegion(evidence,evidence.proof,evidence.source,origins,[])).toBeNull();
 expect(planStreamReflow(f.page,f.s.bytes,fonts,edit())).toBeNull();
});
test('a media-sized unknown still blocks the entire page',async()=>{
 const f=await fixture(first+row('(AB ) Tj')+'/Unknown Do');
 const target=tokenizeContentStream(f.s.bytes).findIndex(op=>op.operator==='Tj');
 expect(streamReflowEvidence(f.page,f.s.bytes,f.fonts,target).ok).toBe(false);
});
test('the occupancy revision changes with source or font dependencies',async()=>{
 const f=await fixture(first+row('(AB ) Tj'));
 const target=tokenizeContentStream(f.s.bytes).findLastIndex(op=>op.operator==='Tj');
 const a=streamReflowEvidence(f.page,f.s.bytes,f.fonts,target);if(!a.ok)throw Error(a.detail);
 const modified=new TextEncoder().encode(new TextDecoder().decode(f.s.bytes)+' 0 g');
 const b=streamReflowEvidence(f.page,modified,f.fonts,target);if(!b.ok)throw Error(b.detail);
 f.font.lookup(PDFName.of('FontDescriptor'),PDFDict).set(PDFName.of('Descent'),f.doc.context.obj(-250));
 const c=streamReflowEvidence(f.page,f.s.bytes,resolveRunFonts(f.page),target);if(!c.ok)throw Error(c.detail);
 expect(a.occupancy.hash).not.toBe(b.occupancy.hash);expect(a.occupancy.hash).not.toBe(c.occupancy.hash);
 const box={x:48,y:134,w:45,h:10};
 expect(queryOccupancy(a.occupancy,box).map(o=>o.id).sort()).toEqual(a.occupancy.items.filter(o=>o.box.x<93&&o.box.x+o.box.w>48&&o.box.y<144&&o.box.y+o.box.h>134).map(o=>o.id).sort());
});
test('placement overlap refuses even when the stationary glyph has no painted ink',async()=>{
 const f=await fixture(first+row('(AB ) Tj')+row('( ) Tj',126));
 const target=tokenizeContentStream(f.s.bytes).findIndex(op=>op.operator==='Tj');
 const e=streamReflowEvidence(f.page,f.s.bytes,f.fonts,target);if(!e.ok)throw Error(e.detail);
 const c=e.source.find(t=>t.unicode==='A')!,origins=e.source.map(t=>[t.original!.x,t.original!.y] as [number,number]);
 origins[0]=[50,132]; // ink is clear; declared descent crosses the space's ascent at 133
 expect(proveGlyphRegion(e,e.proof,e.source,origins,[])).toBeNull();
 expect(c.ink.y).toBe(0);
});
test('new ink outside crop refuses without widening the mask',async()=>{
 const f=await fixture(first+row('(AB ) Tj'));
 const target=tokenizeContentStream(f.s.bytes).findIndex(op=>op.operator==='Tj');
 const e=streamReflowEvidence(f.page,f.s.bytes,f.fonts,target);if(!e.ok)throw Error(e.detail);
 const origins=e.source.map(t=>[t.original!.x,t.original!.y] as [number,number]);origins[0]=[.5,150];
 expect(proveGlyphRegion(e,e.proof,e.source,origins,[])).toBeNull();
});
test('a nonzero member rise stays part of the physical line slots',async()=>{
 const f=await fixture('3 Ts '+first+row('(AB ) Tj'));
 const a=edit();a.coverRects[0]!.y+=3;
 const p=planStreamReflow(f.page,f.s.bytes,f.fonts,a);
 expect(p?.reflow?.proof.lineSlots.map(s=>s.baseline)).toEqual([139]);
 if(!p)throw Error('missing raised-style plan');expect(compileReflowPlan(f.s.bytes,f.fonts,p).ok).toBe(true);
});
