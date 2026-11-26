import {expectRetypeset} from './retypesetAssertions.test';
import {afterEach,expect,spyOn,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {PDFDict,PDFDocument,PDFName,type PDFPage} from 'pdf-lib';
import {applyContentTextEdits} from './apply';
import * as reflowAuto from './reflowAuto';
import {fixture,overlay} from './fixtures.test-support';
import {spacingPage} from './reflowApply.test-support';
import {inspectRunPage,resolveRunFonts} from '../contentStreamEdit/replaceRunPage';
import {applyFontSubstitutions} from '../contentStreamEdit/substitute';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {walkTextPlacements} from '../contentStreamEdit/textState';
import {sourceInkFixture} from './substituteInk.test-support';
import type {ContentTextOutcome} from './outcomes';
import {embeddedOverflowPage} from './substituteReflow.test-support';

const explainStreamReflow=reflowAuto.explainStreamReflow;
const loadFont=(name:string)=>readFile(`node_modules/@docx-editor.dev/fonts/assets/${name}`);
const originalText='S i i i i',replacement='W W W W W W W W';
const edit=(wide=false)=>overlay({originalText,text:replacement,coverRects:[{x:49,y:147,w:wide?201:51,h:14}]});
const fontDict=(page:PDFPage)=>page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict);
async function substitutePage(){
 const f=await spacingPage('BT /F1 10 Tf 14 TL 50 150 Td(S i i i i)Tj ET');
 fontDict(f.page).delete(PDFName.of('ToUnicode'));return f;
}
function snapshot(page:PDFPage){return {source:inspectRunPage(page),resources:page.node.Resources(),contents:page.node.get(PDFName.of('Contents')),objects:page.doc.context.enumerateIndirectObjects().length};}
function expectUnchanged(page:PDFPage,before:ReturnType<typeof snapshot>){
 expect(inspectRunPage(page)).toEqual(before.source);expect(page.node.Resources()).toBe(before.resources);
 expect(page.node.get(PDFName.of('Contents'))).toBe(before.contents);expect(page.doc.context.enumerateIndirectObjects()).toHaveLength(before.objects);
}
async function savedGlyphs(page:PDFPage){
 const saved=await PDFDocument.load(await page.doc.save()),reopened=saved.getPage(0),source=inspectRunPage(reopened);
 if(!source.ok)throw Error(source.reason);const fonts=resolveRunFonts(reopened);
 const walk=walkTextPlacements(tokenizeContentStream(source.bytes),{resolveFont:name=>{
  const f=fonts.find(f=>f.resourceName===name);return f?{...f,ok:true,appliesWordSpacing:f.bytesPerCode===1}:null;
 }});
 if(!walk.ok)throw Error(walk.reason);
 return walk.glyphs.map(g=>({text:fonts.find(f=>f.resourceName===g.fontName)!.unicodeByCode.get(g.code),font:g.fontName,origin:[g.coreQuad[0].x,g.coreQuad[0].y]}));
}
afterEach(()=>{spyOn(reflowAuto,'explainStreamReflow').mockRestore();});

for(const wide of [false,true])test(`substitute ${wide?'slot':'cover'} overflow consumes the prepared font and saves a reflow manifest`,async()=>{
 const f=await substitutePage();
 const planner=spyOn(reflowAuto,'explainStreamReflow').mockImplementation((...args)=>{
  const [candidate,,fonts,,,,replacementFont]=args;
  expect(candidate).not.toBe(f.page);expect(replacementFont?.resourceName).toBe('ShioriSub1');
  expect(fonts).toContain(replacementFont!);
  expect(candidate.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).has(PDFName.of('ShioriSub1'))).toBe(true);
  return explainStreamReflow(...args);
 });
 const result=await applyContentTextEdits(f.page,[edit(wide)],{loadFont});
 expect(planner).toHaveBeenCalledTimes(1);expect(result.outcomes[0]).toMatchObject({mode:'substituted',fidelity:'exact',reflow:{strategy:'wrap'}});
 expect(result.remaining).toEqual([]);
 const glyphs=await savedGlyphs(f.page),manifest=result.outcomes[0]!.reflow!;
 expect(glyphs.map(g=>g.text).join('')).toBe(replacement);expect(glyphs.every(g=>g.font==='ShioriSub1')).toBe(true);
 expect(glyphs.map(g=>g.origin)).toEqual(manifest.output.map(g=>g.origin));
 expect(new Set(glyphs.map(g=>g.origin[1])).size).toBeGreaterThan(1);
 expect(manifest.source.map(g=>g.unicode).join('')).toBe(originalText);
});

test('ordinary overflow reaches whole-run substitution after the original-font reflow refuses',async()=>{
 const f=await spacingPage('BT /F1 10 Tf 14 TL 50 150 Td (S i i i i) Tj ET');
 // Isolate the post-refusal handoff: only a prepared substitute has a recipe.
 spyOn(reflowAuto,'explainStreamReflow').mockImplementation((...args)=>args[6]?explainStreamReflow(...args):{ok:false,gate:'trace-refused'});
 const a={...edit(),text:'S S S S S S S S'};
 const result=await applyContentTextEdits(f.page,[a],{loadFont});
 expect(result.outcomes[0]).toMatchObject({mode:'substituted',fidelity:'exact',reflow:{strategy:'wrap'}});expect(result.remaining).toEqual([]);
 expect((await savedGlyphs(f.page)).map(g=>g.text).join('')).toBe(a.text);
});

for(const wide of [false,true])test(`no exact recipe retypesets the substitute ${wide?'slot':'cover'} overflow atomically`,async()=>{
 const f=await substitutePage(),before=snapshot(f.page);
 spyOn(reflowAuto,'explainStreamReflow').mockReturnValue({ok:false,gate:'trace-refused'});
 const result=await applyContentTextEdits(f.page,[edit(wide)],{loadFont});
 expectRetypeset(f.page,result.outcomes[0],before.source,undefined,'overflow');
 expect(result.remaining).toEqual([]);expect((await savedGlyphs(f.page)).map(g=>g.text).join('').replace(/\s/g,'')).toBe(replacement.replace(/\s/g,''));
});

test('failed overflow retry keeps the original refusal and destination objects',async()=>{
 const f=await substitutePage(),a=edit(),before=snapshot(f.page),accepted=new Set<string>();
 const original:ContentTextOutcome={overlayId:a.id,mode:'unsupported',reason:'overflow',detail:'replacement overflows available space'};
 const outcomes=new Map([[a.id,original]]);
 const planner=spyOn(reflowAuto,'explainStreamReflow').mockReturnValue({ok:false,gate:'trace-refused'});
 await applyFontSubstitutions(f.page,[a],outcomes,accepted,{loadFont});
 expect(planner).toHaveBeenCalledTimes(1);expect(outcomes.get(a.id)).toEqual({...original,substituteGate:'trace-refused'});expect(accepted.size).toBe(0);expectUnchanged(f.page,before);
});

async function tightSourcePage(){
 const f=await embeddedOverflowPage();
 return {...f,edit:overlay({text:replacement,coverRects:[{x:49,y:97,w:32,h:14}]})};
}
test('proved source ink outside a tight cover can use the real reflow region',async()=>{
 const f=await tightSourcePage(),result=await applyContentTextEdits(f.page,[f.edit],{loadFont});
 expect(result.outcomes[0]).toMatchObject({mode:'substituted',fidelity:'exact',reflow:{strategy:'wrap'}});expect(result.remaining).toEqual([]);
 const manifest=result.outcomes[0]!.reflow!;
 expect(manifest.region.box.y).toBeLessThanOrEqual(95.5);expect(manifest.source.map(g=>g.unicode).join('')).toBe('ABCDE');
 expect((await savedGlyphs(f.page)).map(g=>g.text).join('')).toBe(replacement);
});
test('a non-embedded tight-cover source uses approximate layout without an exact mask',async()=>{
 const f=await fixture('BT /F1 10 Tf 14 TL 50 100 Td (ABCDE) Tj ET');
 fontDict(f.page).delete(PDFName.of('ToUnicode'));
 fontDict(f.page).set(PDFName.of('FontDescriptor'),f.doc.context.obj({FontBBox:[0,-400,600,800],Ascent:800,Descent:-400}));
 const a=overlay({text:replacement,coverRects:[{x:49,y:97,w:32,h:14}]}),before=snapshot(f.page);
 const result=await applyContentTextEdits(f.page,[a],{loadFont});
 expectRetypeset(f.page,result.outcomes[0],before.source,replacement,'overflow');
});
for(const kind of ['missing','too-small','disabled']as const)test(`tight source cover retypesets when exact region is ${kind}`,async()=>{
 const f=await tightSourcePage(),before=snapshot(f.page);
 const planner=spyOn(reflowAuto,'explainStreamReflow').mockImplementation((...args)=>{
  if(kind==='missing')return {ok:false,gate:'trace-refused'};
  const explained=explainStreamReflow(...args);
  if(explained.ok&&explained.plan.reflow)explained.plan.reflow.proof={...explained.plan.reflow.proof,box:{x:49,y:99,w:32,h:10}};
  return explained;
 });
 const result=await applyContentTextEdits(f.page,[f.edit],{loadFont,stage5Reflow:kind!=='disabled'});
 expectRetypeset(f.page,result.outcomes[0],before.source,undefined,'overflow');
 if(kind==='disabled')expect(planner).not.toHaveBeenCalled();else expect(planner).toHaveBeenCalledTimes(1);
 expectRetypeset(f.page,result.outcomes[0],before.source,replacement,'overflow');
});

for(const name of ['width-only-overhang','seac-no-bbox']as const)test(`reflow cannot invent source ink for ${name}`,async()=>{
 const f=await sourceInkFixture(name),before=snapshot(f.page);let loads=0;
 const planner=spyOn(reflowAuto,'explainStreamReflow');
 const result=await applyContentTextEdits(f.page,[f.edit],{stage5Type1:{sourceReuse:false},loadFont:async name=>{loads++;return loadFont(name);}});
 expectRetypeset(f.page,result.outcomes[0],before.source,undefined,'overflow');
 expect(loads).toBeGreaterThan(0);expect(planner).not.toHaveBeenCalled();expectRetypeset(f.page,result.outcomes[0],before.source,f.edit.text,'overflow');
});

for(const kind of ['Tr1','Tr2','clipping','unknown-advance','OCR','vertical','form']as const)test(`overflow retry does not admit ${kind}`,async()=>{
 const prefix=kind==='Tr1'?'1 Tr ':kind==='Tr2'?'2 Tr ':kind==='OCR'?'3 Tr ':kind==='clipping'?'0 0 300 200 re W n ':'';
 const f=await fixture(`${prefix}BT /F1 10 Tf 14 TL 50 100 Td ${kind==='unknown-advance'?'/Missing 10 Tf (X) Tj /F1 10 Tf ':''}(ABCDE) Tj ET`);
 const font=fontDict(f.page);font.delete(PDFName.of('ToUnicode'));
 font.set(PDFName.of('FontDescriptor'),f.doc.context.obj({FontBBox:[0,-200,600,800],Ascent:800,Descent:-200}));
 if(kind==='vertical')font.set(PDFName.of('WMode'),f.doc.context.obj(1));
 if(kind==='form'){
  const resources=f.page.node.Resources()!;
  const form=f.doc.context.register(f.doc.context.stream(f.source,{Type:'XObject',Subtype:'Form',BBox:[0,0,300,200],Resources:resources}));
  f.page.node.set(PDFName.of('Resources'),f.doc.context.obj({XObject:{Form:form}}));
  f.page.node.set(PDFName.of('Contents'),f.doc.context.register(f.doc.context.stream(new TextEncoder().encode('/Form Do'))));
 }
 const a=overlay({text:replacement,coverRects:[{x:49,y:97,w:32,h:14}]}),before=snapshot(f.page),accepted=new Set<string>();let loads=0;
 const refusal:ContentTextOutcome={overlayId:a.id,mode:'unsupported',reason:'overflow'},outcomes=new Map([[a.id,refusal]]);
 await applyFontSubstitutions(f.page,[a],outcomes,accepted,{loadFont:async name=>{loads++;return loadFont(name);}});
 expect(outcomes.get(a.id)?.mode).toBe('unsupported');expect(accepted.size).toBe(0);expect(loads).toBe(0);expectUnchanged(f.page,before);
});
