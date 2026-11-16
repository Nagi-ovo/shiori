import {expect,test} from 'bun:test';
import {PDFDict,PDFName} from 'pdf-lib';
import {type1RegionPage} from './reflowRegion.test-support';
import {inspectRunPage,resolveRunFonts,runPageEnvironment} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {walkTextPlacements,type UnplacedShow} from '../contentStreamEdit/textState';
import {sourceFingerprint} from '../contentStreamEdit/replaceRun';
import {traceReflowSource} from './reflowTrace';
import {streamInkResolver} from './reflowInk';
import {buildPageOccupancy} from './regionProof/occupancy';
import {streamReflowEvidence} from './reflowEvidence';
import {planStreamReflow} from './reflowAuto';
import {overlay} from './fixtures.test-support';

// Failure list: stroke promoted to media; stroke accidentally movable;
// missing width/join/cap/miter or hairline underbounded; CTM scale omitted;
// missing glyph hull falls back too narrowly; unknown advance stops blocking.
const body=['AB AB AB ','AB AB AB ','AB '].map((s,i)=>`BT /F1 10 Tf 14 TL 50 ${150-i*14} Td (${s}) Tj ET`).join(' ');
export async function strokeFixture(parameters='.456 w',matrix='1 0 0 1 0 0'){
 const f=await type1RegionPage(`q ${matrix} cm ${parameters} 2 Tr BT /F1 10 Tf 50 180 Td (AB) Tj ET Q ${body}`);
 const inspect=()=>{
  const s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);
  const fonts=resolveRunFonts(f.page),ops=tokenizeContentStream(s.bytes),environment=runPageEnvironment(f.page),hash=sourceFingerprint(s.bytes),unplaced:UnplacedShow[]=[];
  const walk=walkTextPlacements(ops,{resolveFont:name=>{const font=fonts.find(f=>f.resourceName===name);return font?{...font,ok:true,appliesWordSpacing:true}:null;},
   extGStateSetsFont:name=>environment.extGStates?.get(name)?.setsFont??null,onUnplaced:s=>unplaced.push(s)});
  if(!walk.ok)throw Error(walk.reason);
  const trace=traceReflowSource(ops,fonts,hash,environment),ink=streamInkResolver(f.page,fonts),r=f.page.getMediaBox();
  const occupancy=buildPageOccupancy({page:f.page,ops,fonts,trace,ink,glyphs:walk.glyphs,unplaced,sourceHash:hash,dependencyHash:hash,media:{x:r.x,y:r.y,w:r.width,h:r.height}});
  const target=ops.findLastIndex(o=>o.operator==='Tj');
  return {s,fonts,ops,walk,unplaced,occupancy,evidence:streamReflowEvidence(f.page,s.bytes,fonts,target)};
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
