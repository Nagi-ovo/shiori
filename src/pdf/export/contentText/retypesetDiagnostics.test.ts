import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {fixture,overlay} from './fixtures.test-support';
import {applyContentTextEdits} from './apply';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import {runContextSafety} from '../contentStreamEdit/replaceRun';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {bytes} from './fixtures.test-support';

// r31 P2-0 failure list, written before the producer change. The exact-tier
// refusal that routed a row to retypeset is diagnostic evidence; losing it
// hides which operator blocks `unsupported-state` rows. Ways it can fail:
// (1) the retypeset row drops the refusal `detail`;
// (2) the unsafe class is lost or wrong per operator: W, W*, gs, semantic BDC;
// (3) a clip pushed inside q leaks past Q (class on an op that is safe);
// (4) nested causes report the inner one instead of the first that applies;
// (5) the diagnostic changes the written page bytes.
const show='BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET';
const classOf=(stream:string)=>{
 const ops=tokenizeContentStream(bytes(stream)),s=runContextSafety(ops,{});if(!s.ok)throw Error(s.reason);
 const i=ops.findIndex(o=>o.operator==='Tj');return{unsafe:s.unsafe.has(i),cls:s.unsafeOperators.get(i)};
};

test('each unsafe target names the first operator class that made it unsafe',()=>{
 expect(classOf(`q 0 0 300 200 re W n ${show} Q`)).toEqual({unsafe:true,cls:'W'});
 expect(classOf(`q 0 0 300 200 re W* n ${show} Q`)).toEqual({unsafe:true,cls:'W*'});
 expect(classOf(`q /GS0 gs ${show} Q`)).toEqual({unsafe:true,cls:'gs'});
 expect(classOf(`/P <</ActualText (x)>> BDC ${show} EMC`)).toEqual({unsafe:true,cls:'semantic-bdc'});
 expect(classOf(`q 0 0 1 1 re W n /GS0 gs ${show} Q`)).toEqual({unsafe:true,cls:'W'});
 expect(classOf(`q 0 0 1 1 re W n Q ${show}`)).toEqual({unsafe:false,cls:undefined});
 expect(classOf(`/P <</MCID 0>> BDC ${show} EMC`)).toEqual({unsafe:false,cls:undefined});
});

const cases=[
 {stream:`q 0 0 300 200 re W n ${show} Q`,cls:'W',digest:'0f1a1f9d69db9bee'},
 {stream:`q 0 0 300 200 re W* n ${show} Q`,cls:'W*',digest:'749ebea7149be051'},
 {stream:`/P <</ActualText (x)>> BDC ${show} EMC`,cls:'semantic-bdc',digest:'ba86311004222015'},
];
for(const c of cases)test(`a retypeset row keeps the exact refusal detail and unsafe class: ${c.cls}`,async()=>{
 const f=await fixture(c.stream),{outcomes}=await applyContentTextEdits(f.page,[overlay()],{});
 expect(outcomes[0]).toMatchObject({mode:'retypeset',retypeset:{reason:'unsupported-state',refusalDetail:'clip/graphics/semantic dependent target',unsafeOperator:c.cls}});
 // Digests were taken before the diagnostic existed: the page is unchanged.
 const s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);
 expect(createHash('sha256').update(s.bytes).digest('hex').slice(0,16)).toBe(c.digest);
});
