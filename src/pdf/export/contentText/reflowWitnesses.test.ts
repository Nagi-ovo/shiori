import {expect,test} from 'bun:test';
import {PDFDict,PDFName} from 'pdf-lib';
import {type1RegionPage} from './reflowRegion.test-support';
import {inspectRunPage,resolveRunFonts} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {streamReflowEvidence,proveDownwardSlot} from './reflowEvidence';
import {planStreamReflow} from './reflowAuto';
import {overlay} from './fixtures.test-support';

// Failure list (before implementation): a single paragraph gap becomes pitch;
// a different font/size/scope/column lends gaps or measure; modal ties and
// distant lines invent pitch; one two-line group supplies only one gap;
// TL after the position anchor is lost; a foreign occupant bypasses the slot.
const row=(text:string,y:number,x=50,size=10,font='F1')=>`BT /${font} ${size} Tf 0 TL ${x} ${y} Td (${text}) Tj ET `;
const body=[192,178,164].map(y=>row('AB AB AB ',y)).join('');
const target=row('AB ',136);
const edit=overlay({originalText:'A',text:'AB AB AB AB',coverRects:[{x:49.95,y:135.5,w:6.1,h:8}]});
async function fixture(stream=body+target,alias=false,targetRow=-1){
 const f=await type1RegionPage(stream);
 if(alias)f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).set(PDFName.of('F2'),f.doc.context.register(f.font.clone()));
 const s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);
 const fonts=resolveRunFonts(f.page),ops=tokenizeContentStream(s.bytes);
 const op=ops.flatMap((o,i)=>o.operator==='Tj'?[i]:[]).at(targetRow)!;
 const e=streamReflowEvidence(f.page,s.bytes,fonts,op);if(!e.ok)throw Error(e.detail);
 return {...f,s,fonts,e,plan:()=>planStreamReflow(f.page,s.bytes,fonts,edit)};
}
test('two agreeing same-font gaps lend pitch and measure to a nearby one-line paragraph',async()=>{
 const f=await fixture();
 expect(f.e.visualGroup.lines).toHaveLength(1);
 expect(f.e.proof.leadingPt).toBe(14);
 expect(f.e.visualGroup.columnEvidence).toMatchObject({right:95,slack:30,witnessGroups:1,witnessLines:3});
 expect(proveDownwardSlot(f.e,f.e.proof)?.lineSlots.at(-1)).toMatchObject({baseline:122,left:50,right:95});
 expect(f.plan()?.reflow?.layout.strategy).toBe('wrap');
});
test('distant rows at the same edge do not discard the nearby column witnesses',async()=>{
 const f=await fixture(row('AB AB AB ',40)+row('AB AB AB ',26)+body+target);
 expect(f.e.proof.leadingPt).toBe(14);
 expect(f.e.visualGroup.columnEvidence).toMatchObject({right:95,witnessLines:3});
 expect(f.plan()?.reflow?.layout.strategy).toBe('wrap');
});
test('a lone title-to-body gap supplies neither leading nor a downward slot',async()=>{
 const f=await fixture(row('AB AB AB ',164)+target);
 expect(f.e.proof.leadingPt).toBe(0);
 expect(proveDownwardSlot(f.e,f.e.proof)).toBeNull();
 expect(f.plan()).toBeNull();
});
test('one observed gap inside a two-line group is not a growth witness',async()=>{
 const f=await fixture(row('AB AB AB ',150)+target);
 expect(f.e.proof.lineSlots).toHaveLength(1);
 expect(f.e.proof.leadingPt).toBe(0);
 expect(proveDownwardSlot(f.e,f.e.proof)).toBeNull();
});
test('explicit TL after the anchor proves pitch for a lone line',async()=>{
 const f=await fixture('BT /F1 10 Tf 0 TL 50 136 Td 14 TL (AB AB AB ) Tj ET');
 expect(f.e.proof.leadingPt).toBe(14);
 expect(proveDownwardSlot(f.e,f.e.proof)?.lineSlots.at(-1)?.baseline).toBe(122);
 expect(f.plan()?.reflow?.layout.strategy).toBe('wrap');
});
for(const [name,witnesses]of [
 ['one same-font gap',row('AB AB AB ',178)+row('AB AB AB ',164)],
 ['different font',body.replaceAll('/F1','/F2')],
 ['different size',body.replaceAll('10 Tf','12 Tf')],
 ['different scope',`/Aside BMC ${body} EMC `],
 ['different column',body.replaceAll('50 ','180 ')],
 ['distant column rows',[192,178,164].map(y=>row('AB AB AB ',y)).join('')+row('AB ',40)],
 ['disagreeing gaps',row('AB AB AB ',192)+row('AB AB AB ',179)+row('AB AB AB ',164)],
 ['blank source rows between gaps',row('AB AB AB ',192)+row(' ',185)+row('AB AB AB ',178)+row(' ',171)+row('AB AB AB ',164)],
 ['foreign-font rows between gaps',row('AB AB AB ',192)+row('AB ',185,50,10,'F2')+row('AB AB AB ',178)+row('AB ',171,50,10,'F2')+row('AB AB AB ',164)],
 ['paragraph gaps contradict explicit leading',[192,164].map(y=>row('AB AB AB ',y).replace('0 TL','14 TL')).join('')],
]as const)test(`${name} cannot supply a leading witness`,async()=>{
 const f=await fixture(name==='distant column rows'?witnesses:witnesses+target,true);
 expect(f.e.proof.leadingPt).toBe(0);
 expect(proveDownwardSlot(f.e,f.e.proof)).toBeNull();
});
test('two edge rows of another font do not lend measure even with explicit target TL',async()=>{
 const f=await fixture(body.replaceAll('/F1','/F2')+target.replace('0 TL','14 TL'),true);
 expect(f.e.proof.leadingPt).toBe(14);
 expect(f.e.visualGroup.capacityRight).toBe(65);
});
test('a mixed-face visual group cannot lend the other face pitch to its selected tail',async()=>{
 const f=await fixture(body+row('AB ',150,50,10,'F2'),true);
 expect(f.e.proof.lineSlots).toHaveLength(1);
 expect(f.e.proof.leadingPt).toBe(0);
 expect(proveDownwardSlot(f.e,f.e.proof)).toBeNull();
});
test('witnessed leading and column measure still require an empty destination band',async()=>{
 const f=await fixture(body+'0 g 55 120 10 4 re f '+target);
 expect(f.e.proof.leadingPt).toBe(14);
 expect(f.e.visualGroup.capacityRight).toBe(95);
 expect(proveDownwardSlot(f.e,f.e.proof)).toBeNull();
 expect(f.plan()).toBeNull();
});
test('an equally supported pair of pitches is ambiguous',async()=>{
 const rows=[192,182,172,160,148].map(y=>row('AB AB AB ',y)).join('');
 const tied=await fixture(rows,false,2);
 expect(tied.e.proof.leadingPt).toBe(0);
});
test('a unique modal pitch survives a different paragraph gap',async()=>{
 const rows=[192,182,172,162,150,138].map(y=>row('AB AB AB ',y)).join('');
 const f=await fixture(rows,false,2);
 expect(f.e.proof.leadingPt).toBe(10);
});
for(const show of ['T* (AB AB AB ) Tj',"(AB AB AB ) '",'0 0 (AB AB AB ) "'])test(`${show} keeps explicit leading as a witness`,async()=>{
 const f=await fixture(`BT /F1 10 Tf 14 TL 50 178 Td ${show} 1 0 0 1 50 136 Tm (AB AB AB ) Tj ET`);
 expect(f.e.proof.leadingPt).toBe(14);
 expect(proveDownwardSlot(f.e,f.e.proof)?.lineSlots.at(-1)?.baseline).toBe(122);
});
for(const show of ["(AB AB AB ) '",'0 0 (AB AB AB ) "'])test(`${show} rows can witness column gaps and measure`,async()=>{
 const rows=[192,178,164].map(y=>`BT /F1 10 Tf 0 TL 50 ${y} Td ${show} ET `).join('');
 const f=await fixture(rows+target);
 expect(f.e.proof.leadingPt).toBe(14);
 expect(f.e.visualGroup.capacityRight).toBe(95);
 expect(f.plan()?.reflow?.layout.strategy).toBe('wrap');
});
