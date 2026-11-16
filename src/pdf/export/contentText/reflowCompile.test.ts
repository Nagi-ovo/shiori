import {expect,test} from 'bun:test';
import {compileReflowPlan} from './reflowCompile';
import {compilePageReflows} from './reflowBatch';
import {planStreamReflow} from './reflowAuto';
import {spacingPage} from './reflowApply.test-support';
import {overlay} from './fixtures.test-support';
import {inspectRunPage,resolveRunFonts} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {planContentText} from './planner';
import {reflowFixture} from './reflow.fixtures';
import {compileRunPageWithFallback} from '../contentStreamEdit/fallbackPage';
import {applyContentTextEdits} from './apply';

async function compactFixture(suffix=' ET'){
 const f=await spacingPage('BT /F1 10 Tf 14 TL 50 150 Td(S i i i i )Tj 0 -14 Td(S i i i i )Tj 0 -14 Td(S i)Tj'+suffix);
 const source=inspectRunPage(f.page);if(!source.ok)throw Error(source.reason);
 const fonts=resolveRunFonts(f.page),edit=overlay({originalText:'S',text:'n n',coverRects:[{x:49.9,y:120,w:10.2,h:12}]});
 const plan=planStreamReflow(f.page,source.bytes,fonts,edit,{stage5Reflow:true});
 if(!plan?.reflow)throw Error('missing compact reflow recipe');
 return {...f,source,fonts,edit,plan};
}

test.each([' ET','/Tail MP ET'])('compact reflow compiles both boundaries and preserves surrounding bytes: %s',async suffix=>{
 const f=await compactFixture(suffix),ops=tokenizeContentStream(f.source.bytes),recipe=f.plan.reflow!;
 const prefix=f.source.bytes.slice(0,ops[recipe.firstOp]!.start),tail=f.source.bytes.slice(ops[recipe.lastOp]!.end);
 for(const result of [compileReflowPlan(f.source.bytes,f.fonts,f.plan),compilePageReflows(f.source.bytes,f.fonts,f.plan)]){
  expect(result.ok).toBe(true);if(!result.ok)throw Error(result.reason);
  expect(tokenizeContentStream(result.bytes).at(-1)?.operator).toBe('ET');
  expect(result.bytes.slice(0,prefix.length)).toEqual(prefix);
  expect(result.bytes.slice(-tail.length)).toEqual(tail);
  expect(result.bytes[prefix.length]).toBe(32);
  expect(result.bytes[result.bytes.length-tail.length-1]).toBe(32);
 }
 const result=await applyContentTextEdits(f.page,[f.edit],{stage5Substitute:false});
 expect(result.outcomes[0]).toMatchObject({mode:'reflowed',fidelity:'exact'});
 expect(result.remaining).toEqual([]);
 const saved=inspectRunPage(f.page);if(!saved.ok)throw Error(saved.reason);
 expect(tokenizeContentStream(saved.bytes).at(-1)?.operator).toBe('ET');
});

test('a failed verification walk refuses instead of escaping the compiler',()=>{
 const f=reflowFixture(),planned=planContentText(f.content,[f.font],f.overlay,{stage5Reflow:true,reflowRequest:f.request});
 if(!planned.ok||!planned.plan.reflow)throw Error('missing reflow recipe');
 const font={...f.font,widthOf:()=>{throw Error('font metrics could not be read');}};
 const result=compileReflowPlan(f.content,[font],planned.plan);
 expect(result).toMatchObject({ok:false,code:'unsupported-state',bytes:f.content});
});

test('an incomplete recipe refuses atomically through the page compiler',async()=>{
 const f=await compactFixture(),before=inspectRunPage(f.page);
 const plan={...f.plan,reflow:{...f.plan.reflow!,layout:undefined!}};
 expect(compileReflowPlan(f.source.bytes,f.fonts,plan)).toMatchObject({ok:false,code:'unsupported-state',bytes:f.source.bytes});
 expect(await compileRunPageWithFallback(f.page,plan)).toMatchObject({ok:false,code:'unsupported-state'});
 expect(inspectRunPage(f.page)).toEqual(before);
});
