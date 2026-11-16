import {expectRetypeset} from './retypesetAssertions.test';
import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {PDFName} from 'pdf-lib';
import {applyContentTextEdits} from './apply';
import {inspectRunPage,resolveRunFonts} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {walkTextPlacements} from '../contentStreamEdit/textState';
import {overlay} from './fixtures.test-support';
import {requestPage,spacingPage} from './reflowApply.test-support';
const loadFont=(name:string)=>readFile(`node_modules/@docx-editor.dev/fonts/assets/${name}`);
const stream=(last='S i',left=50,first=left)=>`BT /F1 10 Tf 14 TL 1 0 0 1 ${first} 150 Tm (${first===left?'S i i i i ':'S i i i '}) Tj 1 0 0 1 ${left} 136 Tm (S i i i i ) Tj 1 0 0 1 ${left} 122 Tm (${last}) Tj ET`;
const edit=(y=150,text='n n')=>overlay({originalText:'S',text,coverRects:[{x:49.9,y:y-2,w:10.2,h:12}]});
function read(page:Awaited<ReturnType<typeof spacingPage>>['page']){
 const s=inspectRunPage(page);if(!s.ok)throw Error(s.reason);const fonts=resolveRunFonts(page);
 const w=walkTextPlacements(tokenizeContentStream(s.bytes),{resolveFont:name=>{const f=fonts.find(f=>f.resourceName===name);return f?{...f,ok:true,appliesWordSpacing:f.bytesPerCode===1}:null;}});
 if(!w.ok)throw Error(w.reason);return w.glyphs.map(g=>({text:fonts.find(f=>f.resourceName===g.fontName)!.unicodeByCode.get(g.code),x:g.coreQuad[0].x,y:g.coreQuad[0].y}));
}
test('production reflow defaults on and shifts the owned suffix',async()=>{
 const f=await spacingPage(stream()),before=read(f.page),r=await applyContentTextEdits(f.page,[edit(122)]);
 expect(r.outcomes[0]).toMatchObject({mode:'reflowed',fidelity:'exact',reflow:{strategy:'suffix-shift'}});
 const after=read(f.page);expect(after.slice(0,20)).toEqual(before.slice(0,20));expect(after.at(-1)!.x).toBeGreaterThan(before.at(-1)!.x);
});
test('boolean reflow wraps into existing slots with an unchanged unowned neighbour',async()=>{
 const f=await spacingPage(stream()+' BT /F1 10 Tf 1 0 0 1 200 150 Tm (i) Tj ET'),before=read(f.page);
 const r=await applyContentTextEdits(f.page,[edit()],{stage5Reflow:true});
 expect(r.outcomes[0]).toMatchObject({mode:'reflowed',fidelity:'exact',reflow:{strategy:'wrap'}});expect(read(f.page).at(-1)).toEqual(before.at(-1));
 expect(Math.min(...read(f.page).map(g=>g.y))).toBe(122);
});
test('a full paragraph grows by one independently proved empty downward band',async()=>{
 const f=await spacingPage(stream('S i i i i')),r=await applyContentTextEdits(f.page,[edit()]);
 expect(r.outcomes[0]).toMatchObject({mode:'reflowed',fidelity:'exact',reflow:{strategy:'wrap'}});
 const outcome=r.outcomes[0]!;if(!('reflow'in outcome)||!outcome.reflow)throw Error('missing reflow manifest');
 expect(Math.min(...read(f.page).map(g=>g.y))).toBe(108);expect(outcome.reflow.region.box.y).toBeLessThan(108);
});
test('occupied downward band and crop bottom use approximate overflow without pushing',async()=>{
 for(const occupied of [true,false]){
  const f=await spacingPage(stream('S i i i i')+(occupied?' BT /F1 10 Tf 1 0 0 1 60 108 Tm (i) Tj ET':''));
  if(!occupied)f.page.setCropBox(0,115,300,85);
  const before=inspectRunPage(f.page),r=await applyContentTextEdits(f.page,[edit()],{loadFont});
  expectRetypeset(f.page,r.outcomes[0],before,'n n','overflow');
  if(occupied)expect(read(f.page).at(-1)).toEqual({text:'i',x:60,y:108});
 }
});
test('exact reflow opt-out still allows approximate retypesetting',async()=>{
 const f=await spacingPage(stream()),before=inspectRunPage(f.page),r=await applyContentTextEdits(f.page,[edit()],{stage5Reflow:false});
 expectRetypeset(f.page,r.outcomes[0],before,'n n','overflow');
});
test.each(['\n','\r','\r\n'])('user %j hard break stays hard inside a measured paragraph',async br=>{
 const f=await spacingPage(stream()),r=await applyContentTextEdits(f.page,[edit(122,`n${br}n`)]);
 expect(r.outcomes[0]!.mode).toBe('reflowed');
 const ns=read(f.page).filter(g=>g.text==='n');expect(ns).toHaveLength(2);expect(ns[0]!.y-ns[1]!.y).toBe(14);
});
test('automatic Type1 wrap uses PDF widths and conservative ink',async()=>{
 const f=await requestPage(),r=await applyContentTextEdits(f.page,[{...f.overlay,text:'甲乙'}],{stage5Reflow:true,stage5Type1:{sourceReuse:true}});
 expect(r.outcomes[0]).toMatchObject({mode:'reflowed',fidelity:'exact',reflow:{strategy:'wrap'}});
});
test('intersecting paint and stroked text use approximate layout',async()=>{
 for(const prefix of ['50 100 20 20 re f ','1 Tr ']){
  const f=await spacingPage(prefix+stream('S i i i i')),before=inspectRunPage(f.page),r=await applyContentTextEdits(f.page,[edit()],{loadFont});
  expectRetypeset(f.page,r.outcomes[0],before);
 }
});
test('leading TJ first-line indent is taken from the first show',async()=>{
 const f=await spacingPage(stream('S i',50,60).replace('1 0 0 1 60 150 Tm (S i i i ) Tj','1 0 0 1 50 150 Tm [-1000 (S i i i )] TJ'));
 const a={...edit(),coverRects:[{x:59.9,y:148,w:10.2,h:12}]},r=await applyContentTextEdits(f.page,[a]);
 expect(r.outcomes[0]!.mode).toBe('reflowed');expect(read(f.page)[0]!.x).toBe(60);
 expect(read(f.page).find(g=>g.y===136)!.x).toBe(50);
});
test('annotations prevent exact growth but permit approximate layout',async()=>{
 const f=await spacingPage(stream('S i i i i'));f.page.node.set(PDFName.of('Annots'),f.doc.context.obj([{Type:'Annot',Subtype:'Text',Rect:[50,100,100,120]}]));
 const before=inspectRunPage(f.page),r=await applyContentTextEdits(f.page,[edit()],{loadFont});expectRetypeset(f.page,r.outcomes[0],before);
});

test('CID and preinstalled Type0 fallback resources wrap using embedded W',async()=>{
 const {cidReflowPage}=await import('./reflowFull.test-support');
 for(const name of ['F1','ShioriFb1']){
  const f=await cidReflowPage(undefined,name),r=await applyContentTextEdits(f.page,[edit()]);
  expect(r.outcomes[0]).toMatchObject({mode:'reflowed',fidelity:'exact',reflow:{strategy:'wrap'}});expect(Math.min(...read(f.page).map(g=>g.y))).toBe(122);
 }
});
test('line-count changes retain exact round trips or use approximate layout',async()=>{
 const {cidReflowPage}=await import('./reflowFull.test-support');
 for(const originalText of ['S i i i i \nS i i i i ','S i i i i\nS i i i i']){
  const f=await cidReflowPage(),a={...edit(),originalText,text:'n n',coverRects:[{x:49.9,y:148,w:55.2,h:12},{x:49.9,y:134,w:55.2,h:12}]};
  const before=inspectRunPage(f.page),r=await applyContentTextEdits(f.page,[a]);
  if(originalText.endsWith(' '))expect(r.outcomes[0]!.mode).toBe('reflowed');
  else {expectRetypeset(f.page,r.outcomes[0],before);}
 }
});
test('hanging indent preserves the first origin and subsequent body left',async()=>{
 const s='BT /F1 10 Tf 14 TL 1 0 0 1 40 150 Tm (S i i i i i ) Tj 1 0 0 1 50 136 Tm (S i i i i ) Tj 1 0 0 1 50 122 Tm (S i) Tj ET';
 const f=await spacingPage(s),r=await applyContentTextEdits(f.page,[{...edit(),coverRects:[{x:39.9,y:148,w:10.2,h:12}]}]);
 expect(r.outcomes[0]!.mode).toBe('reflowed');expect(read(f.page)[0]!.x).toBe(40);expect(read(f.page).find(g=>g.y===136)!.x).toBe(50);
});
test('environment zero forces reflow off even with explicit true',async()=>{
 const previous=process.env.SHIORI_STAGE5_REFLOW;
 try{
  process.env.SHIORI_STAGE5_REFLOW='0';
  const f=await spacingPage(stream()),r=await applyContentTextEdits(f.page,[edit()],{stage5Reflow:true});
  expect(r.outcomes[0]).toMatchObject({mode:'retypeset',fidelity:'approximate',retypeset:{reason:'overflow'}});
 }finally{if(previous===undefined)delete process.env.SHIORI_STAGE5_REFLOW;else process.env.SHIORI_STAGE5_REFLOW=previous;}
});
test('line-count style changes use approximate layout',async()=>{
 const f=await spacingPage(stream()),before=inspectRunPage(f.page),a={...edit(122,'n\nn'),bold:true};
 const r=await applyContentTextEdits(f.page,[a]);expectRetypeset(f.page,r.outcomes[0],before);
});
test('a short paragraph boundary leaves later same-BT text unowned and fixed',async()=>{
 const f=await spacingPage(stream().replace(' ET',' 1 0 0 1 50 94 Tm (i) Tj ET')),before=read(f.page);
 const r=await applyContentTextEdits(f.page,[edit()]);expect(r.outcomes[0]).toMatchObject({mode:'reflowed',fidelity:'exact',reflow:{strategy:'wrap'}});
 expect(read(f.page).at(-1)).toEqual(before.at(-1));
 const outcome=r.outcomes[0]!;if(!('reflow'in outcome)||!outcome.reflow)throw Error('missing reflow manifest');
 expect(outcome.reflow.source.every(g=>g.origin[1]!>=122)).toBe(true);
});
test('trailing TJ displacement survives reflow for subsequent text at the cursor',async()=>{
 const {traceReflowSource}=await import('./reflowTrace');
 const f=await spacingPage(stream().replace('(S i) Tj','[(S i) 250] TJ'));
 const snapshot=()=>{const s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);const trace=traceReflowSource(tokenizeContentStream(s.bytes),resolveRunFonts(f.page),'revision');return [...trace.ends.values()].at(-1)!.tm;};
 const before=snapshot(),r=await applyContentTextEdits(f.page,[edit()]);expect(r.outcomes[0]!.mode).toBe('reflowed');expect(snapshot()).toEqual(before);
});
test('an explicit measured Type0 substitute can wrap and restores the source font',async()=>{
 const {PDFDict,PDFObjectCopier}=await import('pdf-lib');const {cidReflowPage}=await import('./reflowFull.test-support');
 const {runResourceStamp}=await import('../contentStreamEdit/resourceStamp');
 const f=await requestPage(),cid=await cidReflowPage(),copier=PDFObjectCopier.for(cid.doc.context,f.doc.context);
 const from=cid.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict),fonts=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict);
 fonts.set(PDFName.of('ShioriSub1'),copier.copy(from.get(PDFName.of('F1'))!));
 const request={...f.request,replacementFontResource:'ShioriSub1'},stamp=runResourceStamp(f.page);
 request.dependencyHash=stamp;request.paragraph.dependencyHash=stamp;request.paragraph.evidence.dependencyHash=stamp;
 request.replacementInk=['n',' '].map(unicode=>({unicode,code:Uint8Array.of(0,unicode.charCodeAt(0)),box:unicode===' '?{x:0,y:0,w:0,h:0}:{x:0,y:0,w:1,h:1},proofHash:'glyf-hull'}));
 const a={...f.overlay,text:'n n'},r=await applyContentTextEdits(f.page,[a],{reflowRequests:new Map([[a.id,request]])});
 expect(r.outcomes[0]).toMatchObject({mode:'substituted',fidelity:'exact',reflow:{strategy:'wrap'}});expect(read(f.page).filter(g=>g.text==='n')).toHaveLength(2);
 const source=inspectRunPage(f.page);if(!source.ok)throw Error(source.reason);
 const {traceReflowSource}=await import('./reflowTrace'),state=[...traceReflowSource(tokenizeContentStream(source.bytes),resolveRunFonts(f.page),'revision').ends.values()].at(-1)!;
 expect(state.fontObject).toBe(request.target.fontObject);
});
test('the automatic producer accepts an already measured substitute font',async()=>{
 const {PDFDict,PDFObjectCopier}=await import('pdf-lib');const {cidReflowPage}=await import('./reflowFull.test-support');
 const {planStreamReflow}=await import('./reflowAuto');const {replaceRunPageWithFallback}=await import('../contentStreamEdit/fallbackPage');
 const f=await spacingPage(stream()),cid=await cidReflowPage(),copier=PDFObjectCopier.for(cid.doc.context,f.doc.context);
 const from=cid.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict),dict=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict);
 dict.set(PDFName.of('ShioriSub1'),copier.copy(from.get(PDFName.of('F1'))!));
 const source=inspectRunPage(f.page);if(!source.ok)throw Error(source.reason);const fonts=resolveRunFonts(f.page),font=fonts.find(f=>f.resourceName==='ShioriSub1')!;
 const plan=planStreamReflow(f.page,source.bytes,fonts,edit(),{stage5Reflow:true},{},font);
 expect(plan?.reflow?.substituted).toBe(true);if(!plan)throw Error('missing plan');
 expect((await replaceRunPageWithFallback(f.page,plan)).ok).toBe(true);
 const saved=inspectRunPage(f.page);if(!saved.ok)throw Error(saved.reason);
 expect(new TextDecoder().decode(saved.bytes)).toContain('/ShioriSub1');expect(read(f.page).filter(g=>g.text==='n')).toHaveLength(2);
});
test('CID CFF fallback outlines authorize a measured automatic wrap',async()=>{
 const {cffReflowPage}=await import('./reflowFull.test-support');const f=await cffReflowPage(new Uint8Array(await Bun.file('src/assets/fonts/NotoSansSC-Regular.otf').arrayBuffer()));
 const r=await applyContentTextEdits(f.page,[overlay(f.edit)]);expect(r.outcomes[0]).toMatchObject({mode:'reflowed',fidelity:'exact',reflow:{strategy:'wrap'}});
});

/** Test-supplied slots model the upstream proof contract; actual glyphs,
 * ink, text state and source addresses still come from the PDF stream. */
async function provedStream(stream:string,right=105){
 const {streamReflowEvidence}=await import('./reflowEvidence');
 const f=await spacingPage(stream),content=inspectRunPage(f.page);if(!content.ok)throw Error(content.reason);
 const fonts=resolveRunFonts(f.page),ops=tokenizeContentStream(content.bytes),firstOp=ops.findIndex(op=>op.operator==='Tj');
 const e=streamReflowEvidence(f.page,content.bytes,fonts,firstOp);if(!e.ok)throw Error('missing base stream measurements');
 const glyphs=e.walk.glyphs.filter(g=>e.trace.shows.get(`${g.opIndex}:${g.arrayItemIndex}`)!.before.bt===0);
 const baselines=[...new Set(glyphs.map(g=>g.coreQuad[0].y))];
 const source=glyphs.map(g=>{
  const show=e.trace.shows.get(`${g.opIndex}:${g.arrayItemIndex}`)!,font=fonts.find(f=>f.resourceName===g.fontName)!;
  const measured=e.ink(g.fontName,g.code,show.before);if(!measured)throw Error('missing ink');
  return {unicode:font.unicodeByCode.get(g.code)!,advance:g.coreQuad[1].x-g.coreQuad[0].x,em:10,
   metrics:{size:show.before.size,tc:show.before.tc,tw:show.before.tw},
   ink:measured.box,wordSpace:font.bytesPerCode===1&&g.code===32,fullEmHan:font.widthOf(g.code)===1000,gap:0,
   original:{line:baselines.indexOf(g.coreQuad[0].y),x:g.coreQuad[0].x,y:g.coreQuad[0].y},
   code:Uint8Array.of(g.code),fontResource:g.fontName,fontObject:font.objectId,glyph:measured.glyph,
   source:{...e.proof.owned[0]!,opIndex:g.opIndex,itemIndex:g.arrayItemIndex,byteStart:g.byteOffset,byteEnd:g.byteOffset+g.byteLength}};
 });
 for(let i=0;i<source.length-1;i++)if(source[i]!.original.line===source[i+1]!.original.line)
  source[i]!.gap=source[i+1]!.original.x-source[i]!.original.x-source[i]!.advance;
 const owned=[...new Map(source.map(t=>[t.source.opIndex,{...t.source,byteStart:0,
  byteEnd:source.filter(s=>s.source.opIndex===t.source.opIndex).reduce((n,s)=>n+s.code.length,0)}])).values()];
 const proof={...e.proof,kind:baselines.length===1?'explicit-line-region' as const:'paragraph' as const,owned,
  box:{x:49.5,y:baselines.at(-1)!-2.5,w:right-49,h:baselines[0]!-baselines.at(-1)!+11},
  lineSlots:baselines.map(baseline=>({baseline,left:50,right,kind:'observed' as const}))};
 const obstacles=e.walk.glyphs.filter(g=>!glyphs.includes(g)).map(g=>({
  x:g.coreQuad[0].x,y:g.coreQuad[0].y-2.5,w:g.coreQuad[1].x-g.coreQuad[0].x,h:11,
 }));
 return {...f,content,fonts,e:{...e,source,proof,obstacles}};
}
test('a single proved line shifts its suffix and compiles without moving a lower neighbour',async()=>{
 const {planProvedStreamReflow}=await import('./reflowAuto');
 const {replaceRunPageWithFallback}=await import('../contentStreamEdit/fallbackPage');
 const f=await provedStream('BT /F1 10 Tf 1 0 0 1 50 150 Tm (S i) Tj ET BT /F1 10 Tf 1 0 0 1 50 136 Tm (i) Tj ET',80);
 const before=read(f.page),plan=planProvedStreamReflow(f.e,f.fonts,edit());
 expect(plan?.reflow?.layout.strategy).toBe('suffix-shift');if(!plan)throw Error('missing plan');
 expect(plan.reflow!.proof.lineSlots).toEqual(f.e.proof.lineSlots);expect(plan.reflow!.layout.origins.every(p=>p[1]===150)).toBe(true);
 expect((await replaceRunPageWithFallback(f.page,plan)).ok).toBe(true);
 const after=read(f.page);expect(after.at(-1)).toEqual(before.at(-1));expect(after.at(-2)!.x).toBeGreaterThan(before.at(-2)!.x);
});
test('proved per-line Tc/Tw wrap compiles and retains the untouched justified prefix',async()=>{
 const {planProvedStreamReflow}=await import('./reflowAuto');
 const {replaceRunPageWithFallback}=await import('../contentStreamEdit/fallbackPage');
 const stream='BT /F1 10 Tf 14 TL 1 Tc 2 Tw 1 0 0 1 50 150 Tm (S i i i ) Tj '+
  '.5 Tc .5 Tw 1 0 0 1 50 136 Tm (S i i i i ) Tj 0 Tc 0 Tw 1 0 0 1 50 122 Tm (S i) Tj ET';
 const f=await provedStream(stream,115),before=read(f.page),a={...edit(136),coverRects:[{x:49.9,y:134,w:10.7,h:12}]};
 const plan=planProvedStreamReflow(f.e,f.fonts,a);
 expect(plan?.reflow?.layout.strategy).toBe('wrap');if(!plan)throw Error('missing plan');
 const compiled=await replaceRunPageWithFallback(f.page,plan);
 if(!compiled.ok)throw Error(compiled.reason);expect(compiled.ok).toBe(true);
 expect(read(f.page).filter(g=>g.y===150)).toEqual(before.filter(g=>g.y===150));
 expect(read(f.page).filter(g=>g.text==='n')).toHaveLength(2);
});
test('vertical Identity-V text still refuses automatic reflow atomically',async()=>{
 const {PDFDict}=await import('pdf-lib');const {cidReflowPage}=await import('./reflowFull.test-support');
 const {planStreamReflow}=await import('./reflowAuto');
 const f=await cidReflowPage();f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict).set(PDFName.of('Encoding'),PDFName.of('Identity-V'));
 const before=inspectRunPage(f.page);if(!before.ok)throw Error(before.reason);
 expect(planStreamReflow(f.page,before.bytes,resolveRunFonts(f.page),edit())).toBeNull();
 expect(inspectRunPage(f.page)).toEqual(before);
});
