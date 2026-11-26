import {expectRetypeset} from './retypesetAssertions.test';
import {expect,test} from 'bun:test';
import {PDFName,PDFDict} from 'pdf-lib';
import {fixture,overlay} from './fixtures.test-support';
import {applyContentTextEdits} from './apply';
import {inspectRunPage,resolveRunFonts} from '../contentStreamEdit/replaceRunPage';
import {walkTextPlacements} from '../contentStreamEdit/textState';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {planContentText} from './planner';
import {compilerReason} from './outcomes';
function at(id:string,originalText:string,text:string,x:number,w=6,y=100){const o=overlay({id,originalText,text,coverRects:[{x:x-.1,y:y-1,w:w+.2,h:10}]});return{...o,sourceStyle:{fontSize:o.fontSize,color:o.color,bold:o.bold,italic:o.italic,align:o.align,fontFamily:o.fontFamily,backgroundColor:o.backgroundColor}};}
function placements(page:Awaited<ReturnType<typeof fixture>>['page']){const s=inspectRunPage(page);if(!s.ok)throw Error(s.reason);const fonts=resolveRunFonts(page),walk=walkTextPlacements(tokenizeContentStream(s.bytes),{resolveFont:name=>{const f=fonts.find(f=>f.resourceName===name);return f?{...f,ok:true,appliesWordSpacing:true}:null;}});if(!walk.ok)throw Error(walk.reason);return walk.glyphs.map(g=>({text:fonts.find(f=>f.resourceName===g.fontName)!.unicodeByCode.get(g.code),x:g.coreQuad[0].x,y:g.coreQuad[0].y}));}
test('two nonoverlapping same-line edits keep every original glyph origin',async()=>{
 const f=await fixture();const result=await applyContentTextEdits(f.page,[at('b','B','X',56),at('d','D','Y',68)]);
 expect(result.outcomes.map(o=>o.mode)).toEqual(['in-place','in-place']);
 expect(placements(f.page)).toEqual([{text:'A',x:50,y:100},{text:'X',x:56,y:100},{text:'C',x:62,y:100},{text:'Y',x:68,y:100},{text:'E',x:74,y:100}]);
});
test('changing-advance siblings share one approximate paragraph layout',async()=>{
 const f=await fixture(),before=inspectRunPage(f.page);const result=await applyContentTextEdits(f.page,[at('b','B','',56),at('d','D','YYYY',68)]);
 expect(result.outcomes.map(o=>o.mode)).toEqual(['retypeset','retypeset']);for(const o of result.outcomes)expectRetypeset(f.page,o,before);
 expect(placements(f.page).map(g=>g.text).join('')).toBe('ACYYYYE');
});
test('a refused independent text object does not veto an accepted neighbour',async()=>{
 const f=await fixture('BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET BT /F1 10 Tf 50 70 Td (DE) Tj ET');
 const result=await applyContentTextEdits(f.page,[at('b','B','',56),at('d','D','YYYY',50,6,70)]);
 expect(result.outcomes.map(o=>o.mode)).toEqual(['in-place','retypeset']);
 expect(placements(f.page).slice(0,4)).toEqual([{text:'A',x:50,y:100},{text:'C',x:62,y:100},{text:'D',x:68,y:100},{text:'E',x:74,y:100}]);expect(placements(f.page).slice(4).map(g=>g.text).join('')).toBe('YYYYE');
});
test('a legacy edit without original style always keeps hybrid rendering',async()=>{
 const f=await fixture();expect(planContentText(f.source,resolveRunFonts(f.page),overlay({sourceStyle:undefined,bold:true}))).toMatchObject({ok:false});
});
test('unrelated unsupported font in an independent BT does not abort supported text',async()=>{
 const f=await fixture('BT /Odd 10 Tf 20 20 Td (ZZ) Tj ET BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET');
 f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).set(PDFName.of('Odd'),f.doc.context.register(f.doc.context.obj({Type:'Font',Subtype:'Type3',FontBBox:[0,0,1000,1000],FontMatrix:[.001,0,0,.001,0,0],FirstChar:90,Widths:[600],CharProcs:{},Encoding:{Differences:[90,'Z']}})));
 const result=await applyContentTextEdits(f.page,[at('b','B','X',56)]);expect(result.outcomes[0]!.mode).toBe('in-place');
});
test('safe extended graphics state and named MCID-only properties retain exact editing',async()=>{
 const f=await fixture('q /GS gs BT /F1 10 Tf 50 100 Td /P /Tagged BDC (ABCDE) Tj EMC ET Q');
 f.page.node.Resources()!.set(PDFName.of('ExtGState'),f.doc.context.obj({GS:{Type:'ExtGState',ca:1,CA:1}}));
 f.page.node.Resources()!.set(PDFName.of('Properties'),f.doc.context.obj({Tagged:{MCID:0}}));
 expect((await applyContentTextEdits(f.page,[at('b','B','X',56)])).outcomes[0]!.mode).toBe('in-place');
});
test('malformed compiler diagnostics are never classified as Form XObjects',()=>{expect(compilerReason('malformed Tj operands')).toBe('unsupported-state');});
test('a programmer exception in source encoding propagates instead of becoming a corpus refusal',async()=>{
 const f=await fixture(),fonts=resolveRunFonts(f.page);fonts[0]!.canEncode=()=>{throw new TypeError('encoder defect');};
 const {replaceRuns}=await import('../contentStreamEdit/replaceRun');const p=planContentText(f.source,fonts,at('b','B','X',56));if(!p.ok)throw Error(p.reason);
 expect(()=>replaceRuns(f.source,fonts,p.plan)).toThrow('encoder defect');
});
test('explicit entries in a usecmap map remain usable but absent inherited codes remain unmapped',async()=>{
 const{runToUnicode}=await import('../contentStreamEdit/runToUnicode');
 const m=runToUnicode('/Some-Inherited usecmap 1 beginbfchar <41> <0041> endbfchar',1);expect(m?.get(65)).toBe('A');expect(m?.has(66)).toBe(false);
});
test('existing unique scalar codes can be permuted without unverified source coverage',async()=>{
 const f=await fixture(),fonts=resolveRunFonts(f.page);let calls=0;fonts[0]!.canEncode=()=>{calls++;return{ok:false,reason:'unverified Type1',firstMissing:'A',offset:0};};
 const{replaceRuns}=await import('../contentStreamEdit/replaceRun');const plan=planContentText(f.source,fonts,at('all','ABCDE','BACDE',50,30));if(!plan.ok)throw Error(plan.reason);
 const result=replaceRuns(f.source,fonts,plan.plan);expect(result.ok).toBe(true);expect(calls).toBe(0);if(result.ok)expect(new TextDecoder().decode(result.bytes)).toContain('4241');
});
test('repeated unsupported shows do not veto an independent text object',async()=>{
 const f=await fixture('BT /Odd 10 Tf 20 20 Td (ZZ) Tj (ZZ) Tj ET BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET');
 f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).set(PDFName.of('Odd'),f.doc.context.register(f.doc.context.obj({Type:'Font',Subtype:'Type3',FontBBox:[0,0,1000,1000],FontMatrix:[.001,0,0,.001,0,0],FirstChar:90,Widths:[600],CharProcs:{},Encoding:{Differences:[90,'Z']}})));
 const result=await applyContentTextEdits(f.page,[at('b','B','X',56)]);expect(result.outcomes[0]!.mode).toBe('in-place');
 const saved=inspectRunPage(f.page);expect(saved.ok && new TextDecoder().decode(saved.bytes)).toContain('58');
});
for(const known of [true,false])test(`font-tainted show (${known?'Font gs':'unresolved gs'}) does not veto later explicit-Tf BT`,async()=>{
 const f=await fixture('q BT /F1 10 Tf 20 20 Td /GS gs (ZZ) Tj (ZZ) Tj ET Q BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET');
 if(known)f.page.node.Resources()!.set(PDFName.of('ExtGState'),f.doc.context.obj({GS:{Font:[f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).get(PDFName.of('F1')),10]}}));
 const result=await applyContentTextEdits(f.page,[at('b','B','X',56)]);expect(result.outcomes[0]!.mode).toBe('in-place');
});
test('an explicit matrix makes later tainted-BT text measurable for approximate layout',async()=>{
 const f=await fixture('BT /F1 10 Tf 50 100 Td /GS gs (Z) Tj /F1 10 Tf 1 0 0 1 50 100 Tm (ABCDE) Tj ET'),before=inspectRunPage(f.page);
 const result=await applyContentTextEdits(f.page,[at('b','B','X',56)]);expectRetypeset(f.page,result.outcomes[0],before,'AXCDE');
});
