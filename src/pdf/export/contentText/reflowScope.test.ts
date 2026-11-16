import {expect,test} from 'bun:test';
import {spacingPage} from './reflowApply.test-support';
import {regionRows,regionStream} from './reflowRegion.test-support';
import {resolveRunFonts} from '../contentStreamEdit/replaceRunPage';
import {ContentStreamParseError,tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {traceReflowSource} from './reflowTrace';
import {paragraphMember} from './regionProof/geometry';
import {planStreamReflow} from './reflowAuto';
import {compileReflowPlan} from './reflowCompile';
import {overlay} from './fixtures.test-support';

const enc=new TextEncoder();
const unmarked={open:'',close:''},empty={open:'/ BMC',close:'EMC'};
const nested={open:'/P BMC /Span BMC',close:'EMC EMC'};
const collisions=[
 {name:'empty BMC and unmarked text',left:empty,right:unmarked},
 {name:'escaped separator and nested tags',left:{open:'/P#3eSpan BMC',close:'EMC'},right:nested},
 {name:'BMC and BDC',left:{open:'/P BMC',close:'EMC'},right:{open:'/P <<>> BDC',close:'EMC'}},
];
for(const {name,left,right} of collisions){
 test(`${name} have distinct paragraph membership`,async()=>{
  const stream=regionRows.map((row,i)=>`${i===0?left.open:right.open} BT /F1 10 Tf 14 TL 50 ${150-i*14} Td (${row}) Tj ET ${i===0?left.close:right.close}`).join(' ');
  const f=await spacingPage(stream),fonts=resolveRunFonts(f.page);
  const states=[...traceReflowSource(tokenizeContentStream(enc.encode(stream)),fonts,'revision').shows.values()].map(s=>s.before);
  expect(states.every(s=>s.scopeSafe)).toBe(true);
  expect(states[0]!.mcids).toEqual([]);expect(states[1]!.mcids).toEqual([]);
  expect(paragraphMember(states[0]!,states[1]!)).toBe(false);
 });
 test(`a replacement cannot span ${name}`,async()=>{
  const stream=regionRows.map((row,i)=>i===0?
   `${left.open} BT /F1 10 Tf 14 TL 50 150 Td (S) Tj ${left.close} ${right.open} ( i i i i ) Tj ET ${right.close}`:
   `${right.open} BT /F1 10 Tf 14 TL 50 ${150-i*14} Td (${row}) Tj ET ${right.close}`).join(' ');
  const f=await spacingPage(stream),content=enc.encode(stream),fonts=resolveRunFonts(f.page);
  const edit=overlay({originalText:'S i',text:'n n n n',coverRects:[{x:49.9,y:148,w:20.2,h:12}]});
  expect(planStreamReflow(f.page,content,fonts,edit)).toBeNull();
 });
}
test('scope keys preserve escaped tag bytes and stack boundaries reversibly',()=>{
 const stream='/P#3eSpan BMC /#22#5c#00 BMC BT 0 0 Td (S) Tj ET EMC EMC';
 const state=[...traceReflowSource(tokenizeContentStream(enc.encode(stream)),[],'revision').shows.values()][0]!.before;
 expect(JSON.parse(state.scopeKey!)).toEqual([['BMC','P>Span'],['BMC','"\\\u0000']]);
 const equivalent=stream.replace('/P#3eSpan','/P#3ESpan');
 expect([...traceReflowSource(tokenizeContentStream(enc.encode(equivalent)),[],'revision').shows.values()][0]!.before.scopeKey).toBe(state.scopeKey);
});
test.each(['<</MCID>>','<</MCID % missing value\n>>','<</MCID 0 /MCID>>'])('a dangling MCID dictionary %s refuses parsing and reflow',async dict=>{
 const stream=regionStream(true).replaceAll(/<<\/MCID \d>>/g,'<<>>').replace('<<>>',dict);
 expect(()=>tokenizeContentStream(enc.encode(stream))).toThrow(ContentStreamParseError);
 const f=await spacingPage(stream),fonts=resolveRunFonts(f.page);
 expect(planStreamReflow(f.page,enc.encode(stream),fonts,overlay({originalText:'S',text:'n n',coverRects:[{x:49.9,y:148,w:10.2,h:12}]}))).toBeNull();
});
test.each(['null','/Other','(0)','[]','<<>>','.5','-1','9007199254740992','0 /MCID 1'])('a noninteger or ambiguous MCID %s is scope-unsafe',value=>{
 const stream=`/P <</MCID ${value}>> BDC BT 0 0 Td (S) Tj ET EMC`;
 const state=[...traceReflowSource(tokenizeContentStream(enc.encode(stream)),[],'revision').shows.values()][0]!.before;
 expect(state.scopeSafe).toBe(false);
});
test('a genuinely empty BDC dictionary still permits a same-scope wrap',async()=>{
 const stream=regionStream(true).replaceAll(/<<\/MCID \d>>/g,'<<>>'),f=await spacingPage(stream),fonts=resolveRunFonts(f.page),content=enc.encode(stream);
 const plan=planStreamReflow(f.page,content,fonts,overlay({originalText:'S',text:'n n',coverRects:[{x:49.9,y:134,w:10.2,h:12}]}));
 expect(plan?.reflow?.layout.strategy).toBe('wrap');if(!plan)throw Error('missing empty-property plan');
 expect(compileReflowPlan(content,fonts,plan).ok).toBe(true);
});
