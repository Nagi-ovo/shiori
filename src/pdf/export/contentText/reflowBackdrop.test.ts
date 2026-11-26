import {expect,test} from 'bun:test';
import {PDFName} from 'pdf-lib';
import {type1RegionPage} from './reflowRegion.test-support';
import {inspectRunPage,resolveRunFonts} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {streamReflowEvidence} from './reflowEvidence';
import {reflowScene} from './reflowScene';
import {proveGlyphRegion} from './regionProof/glyphRegion';
import type {OccupantKind} from './regionProof/occupancy';
import type {Rect} from './regionProof';

// Failure list: late fill treated as a backdrop; nonrect bbox mistaken for
// a rectangle; clipping/Pattern/SMask/blend/unknown CTM ignored; smaller paint,
// full-page images (including GSA JPEGs), forms and shading disappear.
const body=['AB AB AB ','AB AB AB ','AB '].map((s,i)=>`BT /F1 10 Tf 14 TL 50 ${150-i*14} Td (${s}) Tj ET`).join(' ');
async function fixture(prefix:string,suffix=''){
 const f=await type1RegionPage(`${prefix} ${body} ${suffix}`);
 const inspect=()=>{
  const s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);
  const ops=tokenizeContentStream(s.bytes),items:{box:Rect;kind:OccupantKind;op:number}[]=[];
  reflowScene(f.page,ops,{x:0,y:0,w:300,h:200},(box,kind,op)=>items.push({box,kind,op}),1);
  const target=ops.findLastIndex(o=>o.operator==='Tj');
  return {items,e:streamReflowEvidence(f.page,s.bytes,resolveRunFonts(f.page),target)};
 };
 return {...f,inspect};
}
for(const fill of ['f','F','f*'])test(`a single full-page rectangle ${fill} before text is a backdrop`,async()=>{
 const f=await fixture(`/Artifact BMC 0 .235 .443 rg 0 0 300 200 re ${fill} EMC`),{items,e}=f.inspect();
 expect(items).toContainEqual({box:{x:0,y:0,w:300,h:200},kind:'backdrop',op:3});
 expect(e.ok).toBe(true);if(e.ok)expect(e.occupancy.pageBlocked).toBe(false);
});
test('a proved translated and scaled rectangle can cover media and crop',async()=>{
 const f=await fixture('q 2 0 0 2 -20 -40 cm 10 20 150 100 re f Q');
 f.page.setCropBox(10,10,280,180);expect(f.inspect().e.ok).toBe(true);
});
test('a smaller coloured rect remains an analytic occupant of that rect',async()=>{
 const f=await fixture('0 .2 .4 rg 0 0 150 200 re f'),{items,e}=f.inspect();
 expect(items.some(o=>o.kind==='backdrop')).toBe(false);
 expect(items).toContainEqual({box:{x:0,y:0,w:151,h:200},kind:'paint',op:2});
 expect(e.ok).toBe(true);if(!e.ok)throw Error(e.detail);
 const old=e.source[0]!,clusters=[{...old,source:undefined,original:undefined,homeOp:old.source!.opIndex},...e.source.slice(1)];
 const origins=e.source.map(t=>[t.original!.x,t.original!.y]as [number,number]);
 // Row-local evidence defers the paint collision to the actual destination.
 expect(proveGlyphRegion(e,e.proof,clusters,origins,[old])).toBeNull();
});
for(const prefix of [
 '0 0 m 300 0 l 150 200 l h f',
 '0 0 300 200 re 20 20 30 30 re f*',
 '0 0 300 200 re S',
 '/Pattern cs /P scn 0 0 300 200 re f',
 '/Unknown cs 0 0 300 200 re f',
 '/Unknown gs 0 0 300 200 re f',
 '0 0 300 200 re W f',
 '0 0 m 300 0 l 150 200 l h W n 0 0 300 200 re f',
 '1 .1 0 1 0 0 cm -100 -100 500 400 re f',
 'sh',
])test(`unproved backdrop stays paint: ${prefix}`,async()=>{
 const f=await fixture(prefix),{items,e}=f.inspect();expect(items.some(o=>o.kind==='backdrop')).toBe(false);expect(e.ok).toBe(false);
});
test('the same full-page fill after text still blocks',async()=>{
 const f=await fixture('','0 0 300 200 re f'),{items,e}=f.inspect();
 expect(items.some(o=>o.kind==='backdrop')).toBe(false);expect(e).toMatchObject({ok:false,gate:'region-unproved',blocker:'obstacles'});
});
for(const effect of [{SMask:PDFName.of('Unknown')},{BM:PDFName.of('Multiply')}])test(`ExtGState effect cannot become a backdrop: ${Object.keys(effect)[0]}`,async()=>{
 const f=await fixture('/Effect gs 0 0 300 200 re f');
 f.page.node.Resources()!.set(PDFName.of('ExtGState'),f.doc.context.obj({Effect:effect}));
 expect(f.inspect().items.some(o=>o.kind==='backdrop')).toBe(false);expect(f.inspect().e.ok).toBe(false);
});
test('Normal blend and no soft mask permit a backdrop',async()=>{
 const f=await fixture('/Effect gs 0 0 300 200 re f');
 f.page.node.Resources()!.set(PDFName.of('ExtGState'),f.doc.context.obj({Effect:{BM:'Normal',SMask:'None'}}));
 expect(f.inspect().e.ok).toBe(true);
});
for(const subtype of ['Image','Form'])test(`a full-page ${subtype} remains blocking`,async()=>{
 const f=await fixture(subtype==='Image'?'q 300 0 0 200 0 0 cm /Im0 Do Q':'/Im0 Do');
 const dict=subtype==='Image'?{Type:'XObject',Subtype:'Image',Width:2550,Height:3300,ColorSpace:'DeviceRGB',BitsPerComponent:8,Filter:'DCTDecode'}:
  {Type:'XObject',Subtype:'Form',BBox:[0,0,300,200]};
 f.page.node.Resources()!.set(PDFName.of('XObject'),f.doc.context.obj({Im0:f.doc.context.register(f.doc.context.stream(new Uint8Array(),dict))}));
 const {items,e}=f.inspect();expect(items.some(o=>o.kind==='backdrop')).toBe(false);expect(e.ok).toBe(false);
});
