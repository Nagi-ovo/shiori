import {expect,test} from 'bun:test';
import {PDFName} from 'pdf-lib';
import {spacingPage} from './reflowApply.test-support';
import {regionStream,regionRows} from './reflowRegion.test-support';
import {inspectRunPage,resolveRunFonts} from '../contentStreamEdit/replaceRunPage';
import {compileReflowPlan} from './reflowCompile';
import {planStreamReflow} from './reflowAuto';
import {streamReflowEvidence} from './reflowEvidence';
import {traceReflowSource} from './reflowTrace';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {overlay} from './fixtures.test-support';
import {mcidCodes,readSlots} from './reflowSlots.test-support';

export const slotEdit=()=>overlay({originalText:'S',text:'n n',coverRects:[{x:49.9,y:134,w:10.2,h:12}]});
export async function slotPlan(stream=regionStream(true)){
 const f=await spacingPage(stream),s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);
 const fonts=resolveRunFonts(f.page),plan=planStreamReflow(f.page,s.bytes,fonts,slotEdit());
 return {...f,content:s.bytes,fonts,plan};
}
test('a Word wrap keeps each MCID code sequence and splits its home show over solved lines',async()=>{
 const f=await slotPlan();expect(f.plan?.reflow?.layout.strategy).toBe('wrap');if(!f.plan)throw Error('missing plan');
 const result=compileReflowPlan(f.content,f.fonts,f.plan);if(!result.ok)throw Error(result.reason);
 const expected=Object.fromEntries(regionRows.map((row,id)=>[id,[...(id===1?row.replace('S','n n'):row)].map(c=>c.charCodeAt(0))]));
 expect(mcidCodes(result.bytes)).toEqual(expected);
 const slots=readSlots(result.bytes).shows.filter(s=>s.mcids.includes(1));
 expect(slots.length).toBeGreaterThan(1);
});
test('a recipe cannot rehome replacement glyphs into another MCID',async()=>{
 const f=await slotPlan();if(!f.plan?.reflow)throw Error('missing plan');
 const reflow={...f.plan.reflow,clusters:f.plan.reflow.clusters.map(c=>c.source?c:{...c,homeOp:f.plan!.reflow!.firstOp})};
 expect(compileReflowPlan(f.content,f.fonts,{...f.plan,reflow})).toMatchObject({ok:false,bytes:f.content});
});
test('Artifact and nested tag scopes never join the P body at the same style',async()=>{
 for(const tag of ['Artifact','H1']){
  const f=await slotPlan(regionStream(true).replace('/P','/'+tag)),ops=tokenizeContentStream(f.content),target=ops.findLastIndex(op=>op.operator==='Tj');
  const traced=traceReflowSource(ops,f.fonts,'revision');
  expect([...traced.shows.values()].map(s=>s.before)).toMatchObject([{scopeKey:tag+'>Span'},{scopeKey:'P>Span'},{scopeKey:'P>Span'}]);
  const e=streamReflowEvidence(f.page,f.content,f.fonts,target);if(!e.ok)throw Error(e.detail);
  expect(e.proof.owned.map(s=>s.opIndex)).not.toContain(ops.findIndex(op=>op.operator==='Tj'));
 }
});
test('a replacement spanning sibling MCIDs refuses even on one visual line',async()=>{
 const stream=regionStream(true).replace('(S i i i i ) Tj ET','(S) Tj ET').replace(' EMC EMC Q',' EMC EMC Q q /P <</MCID 9>> BDC /Span BMC BT /F1 10 Tf 14 TL 60 150 Td ( i i i i ) Tj ET EMC EMC Q');
 const f=await slotPlan(stream),cross=overlay({originalText:'S i',text:'n n n n',coverRects:[{x:49.9,y:148,w:20.2,h:12}]});
 expect(planStreamReflow(f.page,f.content,f.fonts,cross)).toBeNull();
});
for(const blue of [false,true])test(`per-BT colour remains in its source MCID after wrap: blue=${blue}`,async()=>{
 const stream=regionStream(true).replaceAll('BT /F1','BT 0 g 0 G /F1');
 const f=await slotPlan(blue?stream.replace('50 136 Td','0 0 1 rg 50 136 Td'):stream);
 expect(f.plan?.reflow?.layout.strategy).toBe('wrap');if(!f.plan)throw Error('missing colour plan');
 const result=compileReflowPlan(f.content,f.fonts,f.plan);if(!result.ok)throw Error(result.reason);
 const old=readSlots(f.content).shows;
 expect(mcidCodes(result.bytes)).toEqual({...mcidCodes(f.content),1:[...regionRows[1]!.replace('S','n n')].map(c=>c.charCodeAt(0))});
 for(const show of readSlots(result.bytes).shows)expect(show.fill).toBe(old.find(s=>s.mcids[0]===show.mcids[0])!.fill);
});
test('cm between BTs stays refused as a paragraph bridge',async()=>{
 const f=await slotPlan(regionStream(true,' 1 0 0 1 1 0 cm '));
 if(f.plan?.reflow)expect(f.plan.reflow.proof.owned).toHaveLength(2);
});
test('a scope property other than MCID refuses even before the first anchor',async()=>{
 for(const property of ['/ActualText (other)','/Alt (other)','/E (other)','/OC /Layer']){
  const f=await slotPlan(regionStream(true).replaceAll('/MCID 1','/MCID 1 '+property));
  expect(f.plan).toBeNull();
 }
});
test('named MCID properties retain their IDs while membership ignores the numbers',async()=>{
 const f=await spacingPage(regionStream(true).replaceAll('<</MCID 0>>','/Zero').replaceAll('<</MCID 1>>','/One').replaceAll('<</MCID 2>>','/Two'));
 f.page.node.Resources()!.set(PDFName.of('Properties'),f.doc.context.obj({Zero:{MCID:0},One:{MCID:1},Two:{MCID:2}}));
 const s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);
 const {runPageEnvironment}=await import('../contentStreamEdit/replaceRunPage');
 const fonts=resolveRunFonts(f.page),environment=runPageEnvironment(f.page),trace=traceReflowSource(tokenizeContentStream(s.bytes),fonts,'revision',environment);
 expect([...trace.shows.values()].map(s=>s.before)).toMatchObject([{scopeKey:'P>Span',mcids:[0]},{scopeKey:'P>Span',mcids:[1]},{scopeKey:'P>Span',mcids:[2]}]);
 const plan=planStreamReflow(f.page,s.bytes,fonts,slotEdit(),environment);if(!plan)throw Error('missing named MCID plan');
 expect(compileReflowPlan(s.bytes,fonts,plan).ok).toBe(true);
});
test('slot compilation uses the home BT text matrix when equal physical transforms differ',async()=>{
 // Equal physical linear parts; the second BT has a 2x Tm under a .5 CTM.
 const stream=regionStream(true).replace('q /P <</MCID 1>>','q .5 0 0 .5 0 0 cm /P <</MCID 1>>').replace('14 TL 50 136 Td','28 TL 2 0 0 2 100 272 Tm');
 const f=await slotPlan(stream);
 // cm occurs inside the candidate and remains outside M1's production grammar.
 // A manually bounded recipe tests the compiler transform independently.
 const plain=await slotPlan();if(!plain.plan?.reflow)throw Error('missing plan');
 const ops=tokenizeContentStream(f.content),trace=traceReflowSource(ops,f.fonts,'revision');
 const mcids=readSlots(f.content).shows;
 expect(mcids).toHaveLength(3);
 const own=plain.plan.reflow.proof.owned.map((s,i)=>({...s,opIndex:mcids[i]!.op}));
 const map=new Map(plain.plan.reflow.proof.owned.map((s,i)=>[s.opIndex,own[i]!.opIndex]));
 const clusters=plain.plan.reflow.clusters.map(c=>({...c,homeOp:c.source?map.get(c.source.opIndex):mcids[1]!.op,
  source:c.source?{...c.source,opIndex:map.get(c.source.opIndex)!}:undefined}));
 const {sourceFingerprint}=await import('../contentStreamEdit/replaceRun');
 const hash=sourceFingerprint(f.content),lastOp=mcids[2]!.op;
 const recipe={...plain.plan.reflow,clusters,firstOp:mcids[0]!.op,lastOp,proof:{...plain.plan.reflow.proof,owned:own,sourceHash:hash},rejoin:trace.ends.get(lastOp)!};
 const plan={...plain.plan,sourceHash:hash,edits:plain.plan.edits.map(e=>({...e,opIndex:map.get(e.opIndex)!})),reflow:recipe};
 const result=compileReflowPlan(f.content,f.fonts,plan);expect(result.ok).toBe(true);
 if(result.ok)expect(mcidCodes(result.bytes)[1]).toEqual([...regionRows[1]!.replace('S','n n')].map(c=>c.charCodeAt(0)));
});
