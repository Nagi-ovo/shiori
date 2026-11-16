import {expect,test} from 'bun:test';
import {type1RegionPage} from './reflowRegion.test-support';
import {inspectRunPage,resolveRunFonts} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {streamReflowEvidence} from './reflowEvidence';
import {planStreamReflow} from './reflowAuto';
import {overlay} from './fixtures.test-support';

// Failure list: one group counted twice; ragged ends/another column/style
// lend an edge; distant/noncontiguous witnesses; float/paint/unknown in strip;
// obstacle in destination band bypasses cap; crop/clip exceeded; zero slack.
const row=(s:string,y:number,x=50,size=10)=>`BT /F1 ${size} Tf 14 TL ${x} ${y} Td (${s}) Tj ET `;
const short=row('AB ',150),long=(y:number,x=50)=>row('AB AB AB ',y,x);
async function fixture(stream:string,cropRight=300){
 const f=await type1RegionPage(stream);f.page.setCropBox(0,0,cropRight,200);
 const s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);
 const fonts=resolveRunFonts(f.page),target=tokenizeContentStream(s.bytes).findIndex(o=>o.operator==='Tj');
 const e=streamReflowEvidence(f.page,s.bytes,fonts,target);if(!e.ok)throw Error(e.detail);
 return {...f,s,fonts,e};
}
test('two other groups prove a column edge for a short one-line overflow',async()=>{
 const f=await fixture(short+long(122)+long(94));
 expect(f.e.visualGroup.lines).toHaveLength(1);expect(f.e.visualGroup.capacityRight).toBe(95);
 expect(f.e.visualGroup.columnEvidence).toMatchObject({slack:30,witnessGroups:2,sourceGapBefore:false});
 expect(f.e.proof.lineSlots[0]!.right).toBe(95);
 const edit=overlay({originalText:'A',text:'AB AB',coverRects:[{x:49.95,y:149.5,w:6.1,h:8}]});
 expect(planStreamReflow(f.page,f.s.bytes,f.fonts,edit)?.reflow?.layout.strategy).toBe('suffix-shift');
});
for(const [name,witnesses]of [
 ['only one longer sibling',long(122)],
 ['ragged-right siblings',long(122)+row('AB AB AB',94)],
 ['neighbouring column',long(122,180)+long(94,180)],
 ['far-away witnesses',long(80)+long(52)],
 ['different size',row('AB AB AB ',122,50,12)+row('AB AB AB ',94,50,12)],
 ['different marked scope',`/Span BMC ${long(122)+long(94)} EMC`],
]as const)test(`${name} cannot lend capacity`,async()=>{
 const f=await fixture(short+witnesses);expect(f.e.visualGroup.capacityRight).toBe(65);
});
test('two distinct edge rows in one nearby group can lend capacity',async()=>{
 const f=await fixture(short+long(122)+long(108));
 expect(f.e.visualGroup.capacityRight).toBe(95);
 expect(f.e.visualGroup.columnEvidence).toMatchObject({witnessGroups:1,witnessLines:2});
});
test('the edge stays in the target column when a longer neighbouring column exists',async()=>{
 const f=await fixture(short+long(122)+long(94)+long(122,180)+long(94,180));
 expect(f.e.visualGroup.capacityRight).toBe(95);
});
test('side-by-side text at the witness band cannot validate a column edge',async()=>{
 const f=await fixture(short+long(122)+long(94)+row('AB ',122,74));
 expect(f.e.visualGroup.capacityRight).toBe(65);
});
test('a destination-band occupant caps the column grant',async()=>{
 const f=await fixture(short+long(122)+long(94)+'0 g 75 150 5 7 re f');
 expect(f.e.visualGroup.capacityRight).toBe(95);expect(f.e.proof.lineSlots[0]!.right).toBe(74);
});
for(const [name,bridge]of [
 ['paint after text','0 g 50 137 45 2 re f'],
 ['unresolved image','q 50 137 45 2 re W n /Missing Do Q'],
 ['a full-width text float',row('AB AB AB AB AB AB AB AB ',136)],
 ['a side-by-side minipage',row('AB ',136)+row('AB ',136,74)],
]as const)test(`${name} in the witness strip refuses the grant`,async()=>{
 const f=await fixture(short+long(122)+long(94)+bridge);expect(f.e.visualGroup.capacityRight).toBe(65);
});
test('parindent is allowed, but an edge outside crop is not',async()=>{
 const f=await fixture(row('AB ',150,70)+long(122)+long(94));
 expect(f.e.visualGroup.capacityRight).toBe(95);
 const cropped=await fixture(short+long(122)+long(94),90);expect(cropped.e.visualGroup.capacityRight).toBe(65);
});
test('disagreeing witnessed edges choose the leftmost proved edge',async()=>{
 const f=await fixture(row('AB ',110)+long(82)+long(54)+row('AB AB AB',138)+row('AB AB AB',166));
 expect(f.e.visualGroup.capacityRight).toBe(92);
});
test('a justified fragment at the edge has zero slack and keeps its capacity',async()=>{
 const f=await fixture(long(150)+long(122)+long(94));
 expect(f.e.visualGroup.capacityRight).toBe(95);expect(f.e.visualGroup.columnEvidence?.slack).toBe(0);
});
