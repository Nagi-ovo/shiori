import {expect,test} from 'bun:test';
import {PDFDict,PDFName} from 'pdf-lib';
import {glueFixture,readGlue,texLine} from './reflowJustify.test-support';
import {planStreamReflow,planProvedStreamReflow} from './reflowAuto';
import {compileReflowPlan} from './reflowCompile';
import {applyContentTextEdits} from './apply';
import {inspectRunPage,resolveRunFonts} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {traceReflowSource} from './reflowTrace';
import {proveDownwardSlot,streamReflowEvidence} from './reflowEvidence';
import {cidReflowPage} from './reflowFull.test-support';
import {overlay} from './fixtures.test-support';

for(const rowLocal of [false,true])test(`pdfTeX-like longer uses retained TJ glue with fixed last x (rowLocal=${rowLocal})`,async()=>{
 const f=await glueFixture({rowLocal});expect(f.e.ok).toBe(true);if(!f.e.ok)throw Error(f.e.detail);
 expect(!!f.e.proof.rowLocal).toBe(rowLocal);
 const plan=planStreamReflow(f.page,f.s.bytes,f.fonts,f.edit);
 expect(plan?.reflow?.layout.strategy).toBe('row-justify');if(!plan?.reflow)throw Error('missing row-justify');
 const r=plan.reflow,before=readGlue(f.s.bytes,f.fonts);
 expect(r.proof.lineSlots).toEqual(f.e.proof.lineSlots);
 expect(r.layout.origins.at(-1)).toEqual([before.at(-1)!.coreQuad[0].x,100]);
 expect(r.layout.origins.every(p=>p[1]===100)).toBe(true);
 if(rowLocal)expect(proveDownwardSlot(f.e,f.e.proof)).toBeNull();
 const compiled=compileReflowPlan(f.s.bytes,f.fonts,plan);
 expect(compiled.ok).toBe(true);if(!compiled.ok)throw Error(compiled.reason);
 const after=readGlue(compiled.bytes,f.fonts);
 expect(after.at(-1)!.coreQuad[0]).toEqual(before.at(-1)!.coreQuad[0]);
 expect(after.map(g=>g.code)).toEqual([...before.slice(0,rowLocal?2:1).map(g=>g.code),105,...before.slice(rowLocal?2:1).map(g=>g.code)]);
 const trace=traceReflowSource(tokenizeContentStream(compiled.bytes),f.fonts,'compiled');
 expect([...trace.shows.values()].every(s=>s.before.tc===0&&s.before.tw===0)).toBe(true);
});
test('literal-space tagged longer reports row-justify and retains the suffix Tc/Tw',async()=>{
 const stream=`BT /F1 10 Tf 14 TL .03 Tc .2 Tw 50 100 Td /P <</MCID 7>> BDC (${Array(7).fill('AAA').join(' ')}) Tj EMC ET`;
 const f=await glueFixture({stream}),before=readGlue(f.s.bytes,f.fonts);
 const r=await applyContentTextEdits(f.page,[f.edit]);
 expect(r.outcomes[0]!.mode).toBe('reflowed');expect(r.outcomes[0]!.reflow?.strategy).toBe('row-justify');
 const s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);
 expect(readGlue(s.bytes,f.fonts).at(-1)!.coreQuad[0].x).toBeCloseTo(before.at(-1)!.coreQuad[0].x,7);
 const trace=traceReflowSource(tokenizeContentStream(s.bytes),f.fonts,'compiled');
 expect([...trace.shows.values()].every(s=>s.before.tc===.03&&s.before.tw===.2&&s.before.mcids?.[0]===7)).toBe(true);
});
for(const obstacle of ['annotation','paint','rise','artifact','oc']as const)test(`suffix glue refuses ${obstacle}`,async()=>{
 const suffix=obstacle==='paint'?' 58 100 1 7 re f':obstacle==='rise'?
  ' BT /F1 4 Tf 1 0 0 1 69.5 100 Tm 6 Ts (A) Tj ET':
  obstacle==='artifact'||obstacle==='oc'?` BT /F1 10 Tf 69 100 Td ${obstacle==='artifact'?'/Artifact BMC':'/OC /Layer BDC'} (A) Tj EMC ET`:'';
 const f=await glueFixture({stream:texLine()+suffix,annotation:obstacle==='annotation'?[58,100,59,107]:undefined});
 expect(planStreamReflow(f.page,f.s.bytes,f.fonts,f.edit)).toBeNull();
});
test('ink-bearing code 32 is not literal suffix glue',async()=>{
 const f=await glueFixture({stream:`BT /F1 10 Tf 14 TL 50 100 Td (${Array(7).fill('AAA').join(' ')}) Tj ET`,spaceInk:true});
 const p=planStreamReflow(f.page,f.s.bytes,f.fonts,f.edit);
 expect(p?.reflow?.layout.strategy==='row-justify').toBe(false);
});
test('two-byte fonts use proved TJ gaps, never literal code-32 spacing',async()=>{
 for(const tj of [true,false]){
  const stream=`BT /F1 10 Tf 14 TL 50 100 Td ${tj?`[${Array(8).fill('(nnn)').join(' -300 ')}] TJ`:`(${Array(8).fill('nnn').join(' ')}) Tj`} ET`;
  const f=await cidReflowPage(stream),s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);
  // Add a narrow, measured extra letter to the existing TrueType resource.
  const parent=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict);
  const {PDFArray}=await import('pdf-lib');
  const child=parent.lookup(PDFName.of('DescendantFonts'),PDFArray).lookup(0,PDFDict);
  child.set(PDFName.of('W'),f.doc.context.obj([83,[1000],97,[502],110,[502],105,[280]]));
  const fonts=resolveRunFonts(f.page),edit=overlay({originalText:'n',text:'ni',coverRects:[{x:49.99,y:99.9,w:5.02,h:7.2}]});
  const p=planStreamReflow(f.page,s.bytes,fonts,edit);
  if(tj){expect(p?.reflow?.layout.strategy).toBe('row-justify');if(!p)throw Error('missing CID glue');expect(compileReflowPlan(s.bytes,fonts,p).ok).toBe(true);}
  else expect(p?.reflow?.layout.strategy==='row-justify').toBe(false);
 }
});
test('a multi-row window cannot acquire row-justify',async()=>{
 const f=await glueFixture({stream:texLine().replace(' ET',' 1 0 0 1 50 86 Tm (AAA) Tj ET')});
 expect(f.e.ok).toBe(true);if(!f.e.ok)throw Error(f.e.detail);expect(f.e.lines.length).toBe(2);
 expect(planStreamReflow(f.page,f.s.bytes,f.fonts,f.edit)?.reflow?.layout.strategy==='row-justify').toBe(false);
});
test('blocked page, group refusal and unembedded glyphs cannot justify',async()=>{
 const f=await glueFixture();if(!f.e.ok)throw Error(f.e.detail);
 expect(planProvedStreamReflow({...f.e,visualGroup:{...f.e.visualGroup,refusal:'order inversion'}},f.fonts,f.edit)).toBeNull();
 expect(planProvedStreamReflow({...f.e,occupancy:{...f.e.occupancy,pageBlocked:true}},f.fonts,f.edit)).toBeNull();
 f.font.lookup(PDFName.of('FontDescriptor'),PDFDict).delete(PDFName.of('FontFile'));
 const e=streamReflowEvidence(f.page,f.s.bytes,f.fonts,f.e.source[0]!.source!.opIndex);
 if(e.ok)expect(planProvedStreamReflow(e,f.fonts,f.edit)).toBeNull();
});
