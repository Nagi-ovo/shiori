import {expect,test} from 'bun:test';
import {type1RegionPage} from './reflowRegion.test-support';
import {inspectRunPage,resolveRunFonts} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {streamReflowEvidence,proveDownwardSlot} from './reflowEvidence';
import {planStreamReflow} from './reflowAuto';
import {compileReflowPlan} from './reflowCompile';
import {traceReflowSource} from './reflowTrace';
import {overlay} from './fixtures.test-support';

const row=(text:string,y:number,x=50,leading=14,size=10)=>`BT /F1 ${size} Tf ${leading} TL ${x} ${y} Td (${text}) Tj ET `;
const edit=overlay({originalText:'A',text:'AB AB',coverRects:[{x:49.95,y:149.5,w:6.1,h:8}]});
async function fixture(tail='',leading=14,prefix=''){
 const f=await type1RegionPage(prefix+row('AB AB AB ',150,50,leading)+tail),s=inspectRunPage(f.page);
 if(!s.ok)throw Error(s.reason);
 const fonts=resolveRunFonts(f.page),op=tokenizeContentStream(s.bytes).findIndex(o=>o.operator==='Tj');
 const e=streamReflowEvidence(f.page,s.bytes,fonts,op);
 return {...f,s,fonts,e,plan:()=>planStreamReflow(f.page,s.bytes,fonts,edit)};
}
test('an explicit pitch grows into an empty tail and keeps the unowned neighbour fixed',async()=>{
 const f=await fixture(row('AB',70,220));if(!f.e.ok)throw Error(f.e.detail);
 const before=f.e.proof,grown=proveDownwardSlot(f.e,before);expect(grown).not.toBeNull();
 if(!grown)throw Error('missing empty-tail slot');
 expect(grown.leadingPt).toBe(14);
 expect(grown.lineSlots).toEqual([...before.lineSlots,{left:50,right:95,baseline:136,kind:'explicit-blank'}]);
 expect(grown.box.y+grown.box.h).toBe(before.box.y+before.box.h);
 expect(grown.box.x).toBe(before.box.x);expect(grown.box.w).toBe(before.box.w);
 expect(grown.owned).toEqual(before.owned);
 const plan=f.plan();expect(plan?.reflow?.layout.strategy).toBe('wrap');
 if(!plan?.reflow)throw Error('missing empty-tail wrap');
 expect(plan.reflow.proof.lineSlots.map(s=>s.baseline)).toEqual([150,136]);
 const compiled=compileReflowPlan(f.s.bytes,f.fonts,plan);if(!compiled.ok)throw Error(compiled.reason);
 const after=traceReflowSource(tokenizeContentStream(compiled.bytes),f.fonts,'after');
 const neighbour=[...after.shows.values()].at(-1)!,original=[...f.e.trace.shows.values()].at(-1)!;
 expect(neighbour.before.tm).toEqual(original.before.tm);
 expect(neighbour.after.tm).toEqual(original.after.tm);
});

test('two agreeing observed gaps prove growth into an empty tail without TL',async()=>{
 const f=await fixture(row('AB AB AB ',136,50,0)+row('AB AB AB ',122,50,0),0);
 if(!f.e.ok)throw Error(f.e.detail);
 expect(f.e.proof.leadingPt).toBe(14);
 const plan=f.plan();expect(plan?.reflow?.layout.strategy).toBe('wrap');
 if(!plan?.reflow)throw Error('missing observed-pitch wrap');
 expect(plan.reflow.proof.lineSlots.map(s=>s.baseline)).toEqual([150,136,122,108]);
 expect(compileReflowPlan(f.s.bytes,f.fonts,plan).ok).toBe(true);
});

const obstacles=[
 {name:'footnote',tail:'/Note BMC '+row('AB',136,55,0,8)+'EMC '},
 {name:'figure',tail:'55 134 20 3 re f '},
 {name:'side-column glyph',tail:'/Aside BMC '+row('A',136,94)+'EMC '},
 {name:'rule',tail:'1 w 50 136 m 95 136 l S '},
 {name:'unplaced show',tail:row('A',136,55).replace('/F1','/Missing')},
];
for(const {name,tail}of obstacles)test(`${name} in the new band refuses without moving its owner`,async()=>{
 const f=await fixture(tail);
 if(f.e.ok)expect(proveDownwardSlot(f.e,f.e.proof)).toBeNull();
 else expect(f.e.gate).toBe('region-unproved');
 expect(f.plan()).toBeNull();
 const after=inspectRunPage(f.page);expect(after.ok).toBe(true);
 if(!after.ok)throw Error(after.reason);
 expect(after.bytes).toEqual(f.s.bytes);
});

for(const box of ['crop','media'] as const)test(`an empty tail outside the ${box} cannot grow`,async()=>{
 const f=await fixture();
 if(box==='crop')f.page.setCropBox(0,145,300,55);
 else f.page.setMediaBox(0,145,300,55);
 const op=tokenizeContentStream(f.s.bytes).findIndex(o=>o.operator==='Tj');
 const e=streamReflowEvidence(f.page,f.s.bytes,f.fonts,op);if(!e.ok)throw Error(e.detail);
 expect(proveDownwardSlot(e,e.proof)).toBeNull();expect(f.plan()).toBeNull();
});
test('an explicit clip enclosing only the source row cannot authorize a lower slot',async()=>{
 const f=await fixture('Q ',14,'q 45 145 55 20 re W n ');
 if(f.e.ok)expect(proveDownwardSlot(f.e,f.e.proof)).toBeNull();
 expect(f.plan()).toBeNull();
});
test('one paragraph gap cannot invent pitch even when a line-height band is empty',async()=>{
 const f=await fixture('/P BMC '+row('AB AB AB ',108,50,0)+'EMC ',0);
 if(!f.e.ok)throw Error(f.e.detail);
 expect(f.e.proof.lineSlots).toHaveLength(1);expect(f.e.proof.leadingPt).toBe(0);
 expect(proveDownwardSlot(f.e,f.e.proof)).toBeNull();expect(f.plan()).toBeNull();
});
