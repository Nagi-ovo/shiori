import {expect,test} from 'bun:test';
import {spacingPage} from './reflowApply.test-support';
import {overlay} from './fixtures.test-support';
import {inspectRunPage,resolveRunFonts,runPageEnvironment} from '../contentStreamEdit/replaceRunPage';
import {planContentText} from './planner';
import {replaceRuns} from '../contentStreamEdit/replaceRun';
import {planStreamReflow} from './reflowAuto';
import {compileReflowPlan} from './reflowCompile';
import {applyContentTextEdits} from './apply';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {walkTextPlacements} from '../contentStreamEdit/textState';

const stream='BT /F1 10 Tf 1 0 0 1 50 150 Tm (S) Tj 15 0 Td (ii) Tj ET '+
 'BT /F1 10 Tf 1 0 0 1 50 100 Tm (i) Tj ET';
const edit=()=>overlay({originalText:'Sii',text:'Siii',coverRects:[{x:49.9,y:148,w:25.2,h:12}]});
function read(bytes:Uint8Array,fonts:ReturnType<typeof resolveRunFonts>){
 const walk=walkTextPlacements(tokenizeContentStream(bytes),{resolveFont:name=>{
  const f=fonts.find(f=>f.resourceName===name);return f?{...f,ok:true as const,appliesWordSpacing:true}:null;
 }});
 if(!walk.ok)throw Error(walk.reason);
 return walk.glyphs.map(g=>({code:g.code,font:g.fontName,x:g.coreQuad[0].x,y:g.coreQuad[0].y}));
}
test('fixed whole-selection recovery fits when an inserted glyph overflows its byte span',async()=>{
 const f=await spacingPage(stream),source=inspectRunPage(f.page);if(!source.ok)throw Error(source.reason);
 const fonts=resolveRunFonts(f.page),fixed=planContentText(source.bytes,fonts,edit(),runPageEnvironment(f.page));
 expect(fixed.ok).toBe(true);if(!fixed.ok)throw Error(fixed.reason);
 expect(replaceRuns(source.bytes,fonts,fixed.plan)).toMatchObject({ok:false,code:'overflow'});
 const plan=planStreamReflow(f.page,source.bytes,fonts,edit());
 expect(plan?.reflow?.layout).toMatchObject({ok:true,strategy:'fixed',tc:0,tw:0});
 if(!plan?.reflow)throw Error('missing fixed recovery');
 expect(plan.reflow.proof.lineSlots.map(s=>s.baseline)).toEqual([150,100]);
 expect(plan.reflow.layout.origins).toEqual([[50,150],[60,150],[65,150],[70,150],[50,100]]);
 const compiled=compileReflowPlan(source.bytes,fonts,plan);expect(compiled.ok).toBe(true);
 if(!compiled.ok)throw Error(compiled.reason);
 expect(read(compiled.bytes,fonts)).toEqual([
  {code:83,font:'F1',x:50,y:150},{code:105,font:'F1',x:60,y:150},
  {code:105,font:'F1',x:65,y:150},{code:105,font:'F1',x:70,y:150},
  ...read(source.bytes,fonts).slice(-1),
 ]);
 const result=await applyContentTextEdits(f.page,[edit()]);
 expect(result.outcomes[0]).toMatchObject({mode:'reflowed',reflow:{strategy:'fixed'}});
 expect(result.remaining).toEqual([]);
});
for(const refusal of ['paint','disabled'] as const)test(`fixed recovery retains ${refusal} refusal atomically`,async()=>{
 const f=await spacingPage(stream+(refusal==='paint'?' 60 150 5 8 re f':'')),before=inspectRunPage(f.page);
 if(!before.ok)throw Error(before.reason);
 expect(planStreamReflow(f.page,before.bytes,resolveRunFonts(f.page),edit(),{...runPageEnvironment(f.page),stage5Reflow:refusal!=='disabled'})).toBeNull();
 expect(inspectRunPage(f.page)).toEqual(before);
});
