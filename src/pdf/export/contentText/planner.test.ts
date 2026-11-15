import { expect, test } from 'bun:test';
import { planContentText } from './planner';
import { resolveRunFonts } from '../contentStreamEdit/replaceRunPage';
import { replaceRuns } from '../contentStreamEdit/replaceRun';
import { fixture, overlay } from './fixtures.test-support';

async function plan(stream?: string, patch: Parameters<typeof overlay>[0] = {}) {
  const f = await fixture(stream);
  return { ...f, result: planContentText(f.source, resolveRunFonts(f.page), overlay(patch)) };
}
test('maps a mid-word change to exact original code bytes', async () => {
  const { result, source, page } = await plan();
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.plan.edits).toHaveLength(1);
  expect(result.plan.edits[0]).toMatchObject({ opIndex: 3, itemIndex: -1, byteStart: 1, byteEnd: 2, expected: new Uint8Array([66]), replacement: 'X' });
  expect(replaceRuns(source, resolveRunFonts(page), result.plan).ok).toBe(true);
});
test('independent word changes retain the middle word and original kern', async () => {
  const { result } = await plan('BT /F1 10 Tf 50 100 Td [(Cat) -100 ( middle dog)] TJ ET', {
    originalText: 'Cat middle dog', text: 'Bat middle log', coverRects: [{ x:49,y:98,w:90,h:13 }],
  });
  expect(result.ok).toBe(true);
  if(result.ok) expect(result.plan.edits.map(e => [e.itemIndex, e.replacement])).toEqual([[0,'B'],[2,'l']]);
});
test('synthesized spaces between source shows match without inventing source bytes', async () => {
  const { result } = await plan('BT /F1 10 Tf 50 100 Td [(Cat) -600 (dog)] TJ ET', {
    originalText: 'Cat dog', text: 'Bat dog', coverRects: [{ x:49,y:98,w:50,h:13 }],
  });
  expect(result.ok).toBe(true);
  if(result.ok) expect(result.plan.edits[0]).toMatchObject({ itemIndex:0,byteStart:0,byteEnd:1,replacement:'B' });
});
test('multiline changes compile independently without reflow', async () => {
  const { result } = await plan('BT /F1 10 Tf 50 100 Td (ABCDE) Tj 0 -20 Td (FGHIJ) Tj ET', {
    originalText:'ABCDE\nFGHIJ',text:'AXCDE\nFGYIJ',coverRects:[{x:49,y:98,w:32,h:13},{x:49,y:78,w:32,h:13}],
  });
  expect(result.ok).toBe(true);
  if(result.ok) expect(result.plan.edits.map(e => e.opIndex)).toEqual([3,5]);
});
for (const [name,stream,patch,code] of [
  ['mismatch',undefined,{originalText:'Wrong'},'source-mismatch'],
  ['reflow',undefined,{text:'AB\nCDE'},'reflow-required'],
  ['cross-item','BT /F1 10 Tf 50 100 Td [(AB) 10 (CDE)] TJ ET',{text:'AXYE'},'cross-item'],
  ['ambiguous','BT /F1 10 Tf 50 100 Td (ABCDE) Tj 1 0 0 1 50 100 Tm (ABCDE) Tj ET',{coverRects:[{x:49,y:98,w:90,h:13}]},'ambiguous-match'],
  ['rotated','BT /F1 10 Tf 0 1 -1 0 50 100 Tm (ABCDE) Tj ET',{coverRects:[{x:40,y:98,w:20,h:35}]},'unsupported-matrix'],
] as const) test(`refuses ${name} with a stable reason`, async () => {
  const { result } = await plan(stream,patch);
  expect(result).toMatchObject({ok:false,code});
});
test('does not split a decoded ligature cluster',async()=>{
  const f=await fixture(); const fonts=resolveRunFonts(f.page);
  fonts[0]!.unicodeByCode=new Map([[65,'fi'],[66,'B'],[67,'C'],[68,'D'],[69,'E']]);
  expect(planContentText(f.source,fonts,overlay({originalText:'fiBCDE',text:'fxBCDE'}))).toMatchObject({ok:false,code:'glyph-boundary'});
});
test('a pure insertion anchors to a neighbouring glyph and lets the compiler measure overflow',async()=>{
  const {result,source,page}=await plan(undefined,{text:'ABXCDE'});
  expect(result.ok).toBe(true);if(!result.ok)return;
  const compiled=replaceRuns(source,resolveRunFonts(page),result.plan);
  expect(compiled.ok).toBe(false);
  if(!compiled.ok)expect(compiled.reason).toContain('overflows');
});
test('an unrelated font without ToUnicode still contributes exact geometry without blocking the target',async()=>{
 const f=await fixture('BT /F1 10 Tf 50 100 Td (ABCDE) Tj /F2 10 Tf 50 50 Td (ZZ) Tj ET');
 const {PDFName}=await import('pdf-lib');
 const font=f.doc.context.register(f.doc.context.obj({Type:'Font',Subtype:'Type1',BaseFont:'Courier',FirstChar:32,Widths:Array(95).fill(600),Encoding:'WinAnsiEncoding'}));
 f.page.node.Resources()!.lookup(PDFName.of('Font'),(await import('pdf-lib')).PDFDict).set(PDFName.of('F2'),font);
 const fonts=resolveRunFonts(f.page),planned=planContentText(f.source,fonts,overlay());expect(planned.ok).toBe(true);
 if(planned.ok)expect(replaceRuns(f.source,fonts,planned.plan).ok).toBe(true);
});
test('equal-scalar-count changes can split exactly across TJ items while retaining their kerns',async()=>{
 const {result,source,page}=await plan('BT /F1 10 Tf 50 100 Td [(AB) -10 (CDE)] TJ ET',{text:'AXYDE'});
 expect(result.ok).toBe(true);if(!result.ok)return;
 expect(result.plan.edits.map(e=>[e.itemIndex,e.replacement])).toEqual([[0,'X'],[2,'Y']]);
 const compiled=replaceRuns(source,resolveRunFonts(page),result.plan);expect(compiled.ok).toBe(true);
 expect(new TextDecoder().decode(compiled.bytes)).toContain('-10');
});
for(const [tf,matrix]of [[1,10],[200,.05]] as const)test(`compares the UI point size with transformed Tf ${tf} × ${matrix}`,async()=>{
 const {result,source,page}=await plan(`BT /F1 ${tf} Tf ${matrix} 0 0 ${matrix} 50 100 Tm (ABCDE) Tj ET`);
 expect(result.ok).toBe(true);if(result.ok)expect(replaceRuns(source,resolveRunFonts(page),result.plan).ok).toBe(true);
});
test('cross-item edits containing inferred whitespace refuse instead of truncating replacement scalars',async()=>{
 const {result}=await plan('BT /F1 10 Tf 50 100 Td [(AB) -600 (CD)] TJ ET',{
  originalText:'AB CD',text:'AXYZD',coverRects:[{x:49,y:98,w:40,h:13}],
 });
 expect(result).toMatchObject({ok:false,code:'cross-item'});
});
for(const patch of [{bold:true},{italic:true},{color:'#ff0000'},{fontFamily:'serif' as const}])test(`format changes retain hybrid rendering instead of being silently ignored: ${Object.keys(patch)}`,async()=>{
 const original=overlay();const {result}=await plan(undefined,{...patch,sourceStyle:{fontSize:original.fontSize,color:original.color,bold:original.bold,italic:original.italic,align:original.align,fontFamily:original.fontFamily,backgroundColor:original.backgroundColor}});
 expect(result).toMatchObject({ok:false,code:'style-change'});
});
