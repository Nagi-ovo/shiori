import {expect,test} from 'bun:test';
import {planContentText} from './planner';
import {compileReflowPlan} from './reflowCompile';
import {reflowFixture} from './reflow.fixtures';
import {walkTextPlacements} from '../contentStreamEdit/textState';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {replaceRuns} from '../contentStreamEdit/replaceRun';

test('flag-off overflow is unchanged even with an explicit request',()=>{
 const f=reflowFixture();const result=planContentText(f.content,[f.font],f.overlay,{reflowRequest:f.request});
 expect(result.ok).toBe(true);if(!result.ok)return;
 expect(replaceRuns(f.content,[f.font],result.plan)).toMatchObject({ok:false,code:'overflow'});
});
test('an explicit, proven request wraps the owned tail and compiles real PDF operators',()=>{
 const f=reflowFixture();const result=planContentText(f.content,[f.font],f.overlay,{stage5Reflow:true,reflowRequest:f.request});
 expect(result.ok).toBe(true);if(!result.ok)return;
 expect(result.plan.reflow?.layout.strategy).toBe('wrap');
 const compiled=compileReflowPlan(f.content,[f.font],result.plan);expect(compiled.ok).toBe(true);if(!compiled.ok)return;
 const walk=walkTextPlacements(tokenizeContentStream(compiled.bytes),{resolveFont:()=>({...f.font,ok:true,appliesWordSpacing:true})});
 expect(walk.ok).toBe(true);if(!walk.ok)return;
 expect(walk.glyphs.slice(0,8).map(g=>g.coreQuad[0].x)).toEqual([50,60,70,80,90,100,110,120]);
 expect(walk.glyphs[10]!.coreQuad[0]).toEqual({x:50,y:686});
 expect(walk.glyphs.map(g=>f.font.unicodeByCode.get(g.code)).join('')).toBe('甲乙丙丁戊己庚辛卯辰癸甲乙丙丁戊己庚辛壬癸甲乙丙');
});
test('flag-only callers do not acquire guessed paragraph evidence',()=>{
 const f=reflowFixture();f.overlay.text+='\n甲';
 expect(planContentText(f.content,[f.font],f.overlay,{stage5Reflow:true})).toMatchObject({ok:false,code:'reflow-required'});
});
test.each(['dependency','source','ink','whitespace'] as const)('invalid %s proof refuses before compiling',bad=>{
 const f=reflowFixture();
 if(bad==='dependency')f.request.dependencyHash='stale';
 if(bad==='source')f.request.paragraph.sourceHash='stale';
 if(bad==='ink')f.request.sourceInk=[];
 if(bad==='whitespace')f.request.paragraph.evidence.whitespace='inferred';
 expect(planContentText(f.content,[f.font],f.overlay,{stage5Reflow:true,reflowRequest:f.request})).toMatchObject({ok:false,code:'reflow-required'});
});
test('unowned text stays fixed across the original relative-line rejoin',()=>{
 const f=reflowFixture([50,50,50],false,true);
 const result=planContentText(f.content,[f.font],f.overlay,{stage5Reflow:true,reflowRequest:f.request});
 expect(result.ok).toBe(true);if(!result.ok)return;
 const compiled=compileReflowPlan(f.content,[f.font],result.plan);expect(compiled.ok).toBe(true);if(!compiled.ok)return;
 const walk=walkTextPlacements(tokenizeContentStream(compiled.bytes),{resolveFont:()=>({...f.font,ok:true,appliesWordSpacing:true})});
 expect(walk.ok).toBe(true);if(!walk.ok)return;
 expect(walk.glyphs.slice(-2).map(g=>g.coreQuad[0])).toEqual([{x:50,y:658},{x:60,y:658}]);
});
test('an explicit Windows hard break is retained at the replacement boundary',()=>{
 const f=reflowFixture();f.overlay.text='卯\r\n辰';
 const result=planContentText(f.content,[f.font],f.overlay,{stage5Reflow:true,reflowRequest:f.request});
 expect(result.ok).toBe(true);if(!result.ok)return;
 expect(result.plan.reflow?.layout.origins.slice(8,10)).toEqual([[130,700],[50,686]]);
});
