import {expect,test} from 'bun:test';
import {PDFDict,PDFName} from 'pdf-lib';
import {matrixCff,type1RegionPage} from './reflowRegion.test-support';
import {nums,tinyType1,widthChar} from '../fontCoverage/fixtures/type1';
import {inspectRunPage,resolveRunFonts,runPageEnvironment} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {walkTextPlacements,type UnplacedShow} from '../contentStreamEdit/textState';
import {sourceFingerprint} from '../contentStreamEdit/replaceRun';
import {traceReflowSource} from './reflowTrace';
import {streamInkResolver} from './reflowInk';
import {buildPageOccupancy} from './regionProof/occupancy';
import {boundStrokedShow,strokeEnvelopes} from './regionProof/strokeOccupancy';
import {streamReflowEvidence} from './reflowEvidence';
import {planStreamReflow} from './reflowAuto';
import {overlay} from './fixtures.test-support';

// Failure list: stroke promoted to media; stroke accidentally movable;
// missing width/join/cap/miter or hairline underbounded; CTM scale omitted;
// missing glyph hull falls back too narrowly; unknown advance stops blocking.
// P1 failures: horizontal/vertical outlines disappear, including mixed shows;
// unproved point/CFF-empty hulls clear the page or keep only positive glyphs;
// proved-empty paths invent stroke ink; [] bypasses conservative occupancy.
const body=['AB AB AB ','AB AB AB ','AB '].map((s,i)=>`BT /F1 10 Tf 14 TL 50 ${150-i*14} Td (${s}) Tj ET`).join(' ');
export async function strokeFixture(parameters='.456 w',matrix='1 0 0 1 0 0',options:{text?:string;renderMode?:number;body?:string}={}){
 const {text='AB',renderMode=2,body:pageBody=body}=options;
 const f=await type1RegionPage(`q ${matrix} cm ${parameters} ${renderMode} Tr BT /F1 10 Tf 50 180 Td (${text}) Tj ET Q ${pageBody}`);
 const inspect=()=>{
  const s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);
  const fonts=resolveRunFonts(f.page),ops=tokenizeContentStream(s.bytes),environment=runPageEnvironment(f.page),hash=sourceFingerprint(s.bytes),unplaced:UnplacedShow[]=[];
  const walk=walkTextPlacements(ops,{resolveFont:name=>{const font=fonts.find(f=>f.resourceName===name);return font?{...font,ok:true,appliesWordSpacing:true}:null;},
   extGStateSetsFont:name=>environment.extGStates?.get(name)?.setsFont??null,onUnplaced:s=>unplaced.push(s)});
  if(!walk.ok)throw Error(walk.reason);
  const trace=traceReflowSource(ops,fonts,hash,environment),ink=streamInkResolver(f.page,fonts),r=f.page.getMediaBox(),media={x:r.x,y:r.y,w:r.width,h:r.height};
  const occupancy=buildPageOccupancy({page:f.page,ops,fonts,trace,ink,glyphs:walk.glyphs,unplaced,sourceHash:hash,dependencyHash:hash,media});
  const target=ops.findLastIndex(o=>o.operator==='Tj');
  const heading=unplaced[0],state=heading&&trace.shows.get(`${heading.opIndex}:${heading.arrayItemIndex}`)?.before;
  const strokeBounds=(declared?:readonly number[])=>heading&&state?
   boundStrokedShow(heading,state,ink,declared,strokeEnvelopes(f.page,ops).get(heading.opIndex),media,occupancy.guardPt):undefined;
  return {s,fonts,ops,walk,unplaced,occupancy,strokeBounds,evidence:streamReflowEvidence(f.page,s.bytes,fonts,target)};
 };
 return {...f,inspect};
}
test('a stroked heading stays unplaced while a body overflow obtains a region',async()=>{
 const f=await strokeFixture(),e=f.inspect();
 expect(e.unplaced).toHaveLength(1);expect(e.walk.glyphs.some(g=>g.coreQuad[0].y===180)).toBe(false);
 expect(e.occupancy.pageBlocked).toBe(false);expect(e.evidence.ok).toBe(true);
 const heading=e.ops.findIndex(o=>o.operator==='Tj');
 expect(streamReflowEvidence(f.page,e.s.bytes,e.fonts,heading)).toMatchObject({ok:false,gate:'target-state'});
 const edit=overlay({originalText:'A',text:'AB AB',coverRects:[{x:49.95,y:121.5,w:6.1,h:8}]});
 expect(planStreamReflow(f.page,e.s.bytes,e.fonts,edit)?.reflow).toBeDefined();
 const boxes=e.occupancy.items.filter(o=>o.kind==='unplaced');
 expect(boxes.length).toBeGreaterThan(0);expect(boxes.every(o=>o.box.y>170&&o.box.y+o.box.h<200)).toBe(true);
});
for(const parameters of ['-1 w','0 w','4 j','4 J','0 M','/Unknown gs'])test(`unproved stroke remains page-blocking: ${parameters}`,async()=>{
 const f=await strokeFixture(parameters);expect(f.inspect().occupancy.pageBlocked).toBe(true);
});
test('stroke dilation includes joins and CTM scaling',async()=>{
 const f=await strokeFixture('2 w 0 j 2 J 10 M','2 0 0 3 0 -400'),e=f.inspect();
 expect(e.occupancy.pageBlocked).toBe(false);
 const b=e.occupancy.items.filter(o=>o.kind==='unplaced')[0]!.box;
 // Heading baseline is 140; its lower edge must include a 30 pt miter.
 expect(b.y).toBeLessThanOrEqual(109);expect(b.x).toBeLessThan(90);
});
test('ExtGState stroke parameters are proved and q/Q restores them',async()=>{
 const f=await strokeFixture('/Stroke gs');
 f.page.node.Resources()!.set(PDFName.of('ExtGState'),f.doc.context.obj({Stroke:{LW:.5,LJ:1,LC:1,ML:2}}));
 expect(f.inspect().occupancy.pageBlocked).toBe(false);
 f.page.node.Resources()!.lookup(PDFName.of('ExtGState'),PDFDict).lookup(PDFName.of('Stroke'),PDFDict).set(PDFName.of('LW'),PDFName.of('Unknown'));
 expect(f.inspect().occupancy.pageBlocked).toBe(true);
});
test('declared non-CFF envelope bounds a stroke when its glyph cannot be measured',async()=>{
 const f=await strokeFixture();
 f.font.lookup(PDFName.of('FontDescriptor'),PDFDict).delete(PDFName.of('FontFile'));
 const e=f.inspect();expect(e.occupancy.pageBlocked).toBe(false);
 expect(e.occupancy.items.filter(o=>o.kind==='unplaced').every(o=>o.box.w>=300)).toBe(true);
});

const lineGlyph=(w:number,h:number)=>Uint8Array.from([...nums(0,600),13,...nums(0,0),21,...nums(w,h),5,14]);
function strokeGlyphs(f:Awaited<ReturnType<typeof strokeFixture>>,glyphs:Record<string,Uint8Array>){
 const p=tinyType1({glyphs:{'.notdef':widthChar(0),...glyphs}});
 f.font.lookup(PDFName.of('FontDescriptor'),PDFDict).set(PDFName.of('FontFile'),f.doc.context.register(f.doc.context.flateStream(p.program,
  {Length1:p.length1,Length2:p.length2,Length3:p.length3})));
}
for(const renderMode of [1,2])for(const [w,h]of [[400,0],[0,700]])test(`Tr ${renderMode} preserves a stroked ${w}x${h} outline as a ribbon`,async()=>{
 const f=await strokeFixture('2 w 1 j 0 J',undefined,{text:'A',renderMode,body:''});
 strokeGlyphs(f,{A:lineGlyph(w!,h!)});
 const e=f.inspect(),boxes=e.strokeBounds(),radius=Math.SQRT2+e.occupancy.guardPt;
 expect(boxes).toHaveLength(1);const b=boxes![0]!;
 expect(b.x).toBeCloseTo(50-radius);expect(b.y).toBeCloseTo(180-radius);
 expect(b.w).toBeCloseTo(w!/100+2*radius);expect(b.h).toBeCloseTo(h!/100+2*radius);
 expect(Math.min(b.w,b.h)).toBeGreaterThanOrEqual(2*radius);
 expect(e.occupancy.items.filter(o=>o.kind==='unplaced').map(o=>o.box)).toEqual(boxes);
 expect(e.occupancy.pageBlocked).toBe(false);expect(e.walk.glyphs).toHaveLength(0);
});
test('a mixed stroked show protects both positive-area ink and its 1D rule',async()=>{
 const f=await strokeFixture('2 w 1 j 0 J',undefined,{body:''});
 strokeGlyphs(f,{A:lineGlyph(400,700),B:lineGlyph(400,0)});
 const e=f.inspect(),boxes=e.strokeBounds(),radius=Math.SQRT2+e.occupancy.guardPt;
 expect(boxes).toHaveLength(2);
 expect(boxes![1]!.x).toBeCloseTo(56-radius);expect(boxes![1]!.h).toBeCloseTo(2*radius);
 expect(e.occupancy.items.filter(o=>o.kind==='unplaced').map(o=>o.box)).toEqual(boxes);
});
test.each(['A','AB'])('an unproved point outline in (%s) falls back to the declared non-CFF band',async text=>{
 const f=await strokeFixture('2 w 1 j 0 J',undefined,{text,body:''});
 strokeGlyphs(f,{A:lineGlyph(0,0),B:lineGlyph(400,700)});
 const e=f.inspect(),radius=Math.SQRT2+e.occupancy.guardPt;
 expect(e.strokeBounds()).toBeUndefined();
 const boxes=e.occupancy.items.filter(o=>o.kind==='unplaced').map(o=>o.box);
 expect(boxes).toHaveLength(1);expect(boxes[0]!.x).toBe(0);expect(boxes[0]!.w).toBe(300);
 expect(boxes[0]!.y).toBeCloseTo(180-radius);expect(boxes[0]!.h).toBeCloseTo(7+2*radius);
 expect(e.occupancy.pageBlocked).toBe(false);
});
test.each(['FontFile3','FontFile2'])('an unproved empty CFF path in %s keeps the page blocked despite a FontBBox',async slot=>{
 const f=await strokeFixture(undefined,undefined,{text:'A',body:''}),d=f.font.lookup(PDFName.of('FontDescriptor'),PDFDict);
 const bytes=matrixCff();bytes.fill(14,bytes.length-13); // Same-size A charstring, endchar before any path.
 d.delete(PDFName.of('FontFile'));
 d.set(PDFName.of(slot),f.doc.context.register(f.doc.context.flateStream(bytes,{Subtype:'Type1C'})));
 const e=f.inspect();
 expect(e.unplaced[0]?.glyphs).toHaveLength(1);
 expect(e.strokeBounds()).toBeUndefined();
 expect(e.occupancy.pageBlocked).toBe(true);
 expect(e.occupancy.items.filter(o=>o.kind==='unplaced').map(o=>o.box)).toEqual([{x:0,y:0,w:300,h:200}]);
});
test('Type1 proved-empty paths add no measured stroke ink; an empty bound still falls through',async()=>{
 const f=await strokeFixture(undefined,undefined,{text:'A',body:''});strokeGlyphs(f,{A:widthChar()});
 const e=f.inspect();expect(e.strokeBounds()).toEqual([]);
 // No measured box is not an occupancy proof: [] must retain the page fallback.
 expect(e.occupancy.pageBlocked).toBe(true);
 expect(e.occupancy.items.filter(o=>o.kind==='unplaced').map(o=>o.box)).toEqual([{x:0,y:0,w:300,h:200}]);
});
test('a proved-empty Type1 glyph contributes no stroke box beside real ink',async()=>{
 const f=await strokeFixture(undefined,undefined,{body:''});strokeGlyphs(f,{A:lineGlyph(400,700),B:widthChar()});
 const e=f.inspect();expect(e.strokeBounds()).toHaveLength(1);
 expect(e.occupancy.items.filter(o=>o.kind==='unplaced').map(o=>o.box)).toEqual(e.strokeBounds());
 expect(e.occupancy.pageBlocked).toBe(false);
});
