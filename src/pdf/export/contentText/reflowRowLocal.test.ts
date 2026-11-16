import {expect,test} from 'bun:test';
import {PDFName} from 'pdf-lib';
import {rowLocalFixture,requireRowEvidence,replacement,origins,tightRow,fontDescriptor} from './reflowRowLocal.test-support';
import {proveGlyphRegion} from './regionProof/glyphRegion';
import {streamReflowEvidence,proveDownwardSlot} from './reflowEvidence';
import {solveMeasuredReflow} from './reflowLayout';
import {planStreamReflow} from './reflowAuto';
import {compileReflowPlan} from './reflowCompile';
import {overlay} from './fixtures.test-support';

test('10 pt k/g rows at 9.9 pt pitch keep their own observed slot and guard clearance',async()=>{
 const f=await rowLocalFixture(),e=requireRowEvidence(f);
 expect(e.proof).toMatchObject({rowLocal:true,lineSlots:[{left:50,right:74,baseline:140.1,kind:'observed-row'}]});
 const clusters=[...e.source];clusters[1]=replacement(e,1,'k');
 const region=proveGlyphRegion(e,e.proof,clusters,origins(e),[e.source[1]!]);
 expect(region).not.toBeNull();expect(region?.mask).toHaveLength(2);
 expect(region?.mask?.every(b=>b.y>=139.1&&b.y+b.h<=150.4+1e-7)).toBe(true);
 expect(proveDownwardSlot(e,e.proof)).toBeNull();
});
test('a small replacement-only spacing edit compiles while the adjacent row and suffix stay fixed',async()=>{
 const f=await rowLocalFixture(),e=requireRowEvidence(f);
 const p=planStreamReflow(f.page,f.s.bytes,f.fonts,overlay({originalText:'g',text:'AB',coverRects:[{x:49.95,y:139.8,w:6.1,h:8}]}));
 expect(p?.reflow?.layout.strategy).toBe('spacing-only');if(!p?.reflow)throw Error('missing row-local plan');
 expect(p.reflow.proof).toMatchObject({rowLocal:true});
 expect(p.reflow.layout.origins.slice(2)).toEqual(origins(e).slice(1));
 expect(compileReflowPlan(f.s.bytes,f.fonts,p).ok).toBe(true);
});
test('same-row excluded glyphs outside a split fragment remain obstacles without erasing it',async()=>{
 const f=await rowLocalFixture(tightRow(150)+`BT /F1 10 Tf 9.9 TL 50 140.1 Td /Artifact BMC (g) Tj EMC 1 0 0 1 56 140.1 Tm (kgk) Tj ET`,2),e=requireRowEvidence(f);
 expect(e.lines[0]?.sourceGapBefore).toBe(true);
 expect(e.proof.lineSlots).toEqual([{left:56,right:74,baseline:140.1,kind:'observed-row'}]);
 const clusters=[...e.source];clusters[0]=replacement(e,0,'k');
 expect(proveGlyphRegion(e,e.proof,clusters,origins(e),[e.source[0]!])).not.toBeNull();
});
for(const scope of ['/Artifact BMC','/OC /Layer BDC'])test(`an interleaved foreign ${scope} glyph refuses row-local authority`,async()=>{
 const f=await rowLocalFixture(tightRow(150)+`BT /F1 10 Tf 9.9 TL 50 140.1 Td (g) Tj ${scope} (k) Tj EMC (gk) Tj ET`,3);
 expect(f.e.ok).toBe(false);
});
test('a count-two tight-leading window cannot use row-local authority',async()=>{
 const f=await rowLocalFixture(tightRow(159.9)+tightRow(150)+tightRow(140.1),1);
 expect(f.e).toMatchObject({ok:false,gate:'region-unproved'});
});
for(const kind of ['taller','left','right','pen-end','new-guard','ink-on-ink','placement','crop','stale']as const)test(`row-local destination refuses ${kind}`,async()=>{
 const f=await rowLocalFixture(),e=requireRowEvidence(f),clusters=[...e.source],p=origins(e);
 clusters[1]=replacement(e,1,kind==='taller'?'É':'k');
 if(kind==='left')p[1]![0]=49;
 if(kind==='right')p[1]![0]=73;
 if(kind==='pen-end')p[1]![0]=69; // Ink ends at 72; the pen ends at 75 > own end 74.
 if(kind==='new-guard')p[1]![0]+=.25; // A new sliver in the preceding k's guard ring.
 if(kind==='ink-on-ink')p[1]![1]+=.7;
 if(kind==='placement')p[1]![0]=50;
 if(kind==='crop')e.crop={x:0,y:0,w:300,h:149.5};
 if(kind==='stale')e.occupancy.hash+='changed';
 expect(proveGlyphRegion(e,e.proof,clusters,p,[e.source[1]!])).toBeNull();
});
test('an annotation over the replacement cannot be grandfathered as a source guard collision',async()=>{
 const f=await rowLocalFixture(undefined,1,[56,141,59,148]);
 if(!f.e.ok){expect(f.e.gate).toBe('region-unproved');return;}
 const e=f.e,clusters=[...e.source];clusters[1]=replacement(e,1,'k');
 expect(proveGlyphRegion(e,e.proof,clusters,origins(e),[e.source[1]!])).toBeNull();
});
test('an unembedded source row cannot obtain row-local authority',async()=>{
 const f=await rowLocalFixture();fontDescriptor(f).delete(PDFName.of('FontFile'));
 expect(streamReflowEvidence(f.page,f.s.bytes,f.fonts,f.op).ok).toBe(false);
});
test('a partial coarse cap below the observed end still requires the row-local proof',async()=>{
 const f=await rowLocalFixture(tightRow(150,'k',62)+tightRow(140.1),1),e=requireRowEvidence(f);
 expect(e.proof).toMatchObject({rowLocal:true,lineSlots:[{right:74}]});
});
for(const paint of ['56 141 3 7 re f','q 3 0 0 7 56 141 cm /Image Do Q','q 1 0 0 1 56 141 cm /Form Do Q'])test(`a row-local replacement cannot overlap stationary paint: ${paint}`,async()=>{
 const f=await rowLocalFixture(undefined,1),ctx=f.doc.context;
 f.page.node.Resources()!.set(PDFName.of('XObject'),ctx.obj({
  Image:ctx.register(ctx.flateStream(new Uint8Array([0]),{Type:'XObject',Subtype:'Image',Width:1,Height:1,ColorSpace:'DeviceGray',BitsPerComponent:8})),
  Form:ctx.register(ctx.flateStream('0 0 3 7 re f',{Type:'XObject',Subtype:'Form',BBox:[0,0,3,7]})),
 }));
 const bytes=new TextEncoder().encode(new TextDecoder().decode(f.s.bytes)+' '+paint),result=streamReflowEvidence(f.page,bytes,f.fonts,f.op);
 expect(result.ok).toBe(true);if(!result.ok)throw Error(result.detail);
 const clusters=[...result.source];clusters[1]=replacement(result,1,'k');
 expect(proveGlyphRegion(result,result.proof,clusters,origins(result),[result.source[1]!])).toBeNull();
});
test('row-local proof disables suffix movement and wrapping even when explicitly requested',async()=>{
 const f=await rowLocalFixture(),e=requireRowEvidence(f);
 const source=e.source,inserted=[replacement(e,0,'g'),replacement(e,0,'k')];
 // Generous slots make both ordinary tactics possible; rowLocal itself must forbid them.
 const proof={...e.proof,lineSlots:[{...e.proof.lineSlots[0]!,right:200},{left:50,right:200,baseline:130.2,kind:'explicit-blank' as const}]};
 for(const allowSuffix of [true,false])expect(solveMeasuredReflow({source,replacement:inserted,start:0,end:1,proof,softBreaks:[0],allowSuffix,allowWrap:true})).toMatchObject({ok:false,code:'overflow'});
});
