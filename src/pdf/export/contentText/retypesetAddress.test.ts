import {expect,test} from 'bun:test';
import {PDFDict,PDFName} from 'pdf-lib';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {fixture,overlay} from './fixtures.test-support';
import {readRetypesetSource,address} from './retypesetSource';
import {planRetypeset,selectRetypeset} from './retypesetPlan';
import type {RetypesetEdit} from './retypesetTypes';
import {applyContentTextEdits} from './apply';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';

// Failure list is recorded in STATUS.md before these tests and the fix.
async function source(stream:string,unicode?:string){
 const f=await fixture(stream);
 if(unicode){
  const font=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict);
  font.set(PDFName.of('ToUnicode'),f.doc.context.register(f.doc.context.stream(new TextEncoder().encode(unicode))));
 }
 const ops=tokenizeContentStream(f.source),read=readRetypesetSource(f.page,ops);
 expect(read.walk.ok).toBe(true);
 const edit=(patch:Parameters<typeof overlay>[0]):RetypesetEdit=>{
  const o=overlay(patch);return{overlay:o,reason:'overflow',selected:selectRetypeset(read.glyphs,o)};
 };
 return{...f,...read,ops,edit,plan:(edits:RetypesetEdit[])=>planRetypeset(read.glyphs,ops,edits)};
}
const output=(plan:ReturnType<typeof planRetypeset>)=>plan.output.map(a=>a.text).join('');

for(const tr of [0,2])for(const originalText of ['AUTUMN 2019 SECTION','AUTUMN2019SECTION'])
 test(`overlapping advances remain one visual line (Tr ${tr}, ${originalText})`,async()=>{
  const s=await source(`BT /F1 10 Tf ${tr} Tr -0.35 Tc 50 100 Td (AUTUMN 2019 SECTION) Tj ET`);
  expect(s.glyphs[1]!.x-s.glyphs[0]!.glyph.coreQuad[1].x).toBeCloseTo(-.35);
  const edit=s.edit({originalText,text:'new title',coverRects:[{x:49,y:98,w:110,h:13}]});
  const plan=s.plan([edit]);
  expect(plan.group.lines).toHaveLength(1);
  expect(plan.tail.map(g=>address(g.glyph))).toEqual(edit.selected.map(g=>address(g.glyph)));
  expect(output(plan)).toBe('new title');
 });

test('typographic advances include negative spacing beyond the ink join allowance',async()=>{
 const s=await source('BT /F1 10 Tf -5.2 Tc 50 100 Td (ABCDE) Tj ET');
 const plan=s.plan([s.edit({text:'new title'})]);
 expect(plan.group.lines).toHaveLength(1);expect(plan.tail).toHaveLength(5);
});

test('same-baseline candidates sort by x rather than show order',async()=>{
 const s=await source('BT /F1 10 Tf 62 100 Td (CDE) Tj 1 0 0 1 50 100 Tm (AB) Tj ET');
 const plan=s.plan([s.edit({text:'new title'})]);
 expect(plan.group.lines).toHaveLength(1);expect(output(plan)).toBe('new title');
});

test('tagged phrases and a restored nested clip stay in the selected visual paragraph',async()=>{
 const s=await source('/P <</MCID 1>> BDC q BT /F1 10 Tf 50 100 Td (AB) Tj ET Q EMC '+
  'q 0 0 300 200 re W n q 0 0 200 180 re W* n Q Q '+
  '/P <</MCID 2>> BDC q BT /F1 10 Tf 62 100 Td (CD) Tj ET Q EMC '+
  '/Span BMC BT /F1 7 Tf 74 102 Td (2) Tj ET EMC '+
  'BT /F1 10 Tf 78.2 100 Td (EF) Tj ET BT /F1 10 Tf 50 86 Td (GHIJK) Tj ET',
  '11 beginbfchar <41> <653f> <42> <5e9c> <43> <516c> <44> <5171> <45> <6570> <46> <636e> '+
  '<47> <56fd> <48> <6c11> <49> <5171> <4a> <6709> <4b> <004b> endbfchar');
 const edit=s.edit({originalText:'政府公共2数据',text:'新的段落',coverRects:[{x:49,y:98,w:43,h:14}]});
 expect(edit.selected).toHaveLength(7);
 const plan=s.plan([edit]);
 expect(plan.group.lines[0]!.glyphs.map(g=>g.text).join('')).toBe('政府公共2数据');
 expect(plan.tail).toHaveLength(12);
 expect(output(plan)).toBe('新的段落国民共有K');
});

test('unselected same-baseline neighbours cross marked-content and q scopes',async()=>{
 const s=await source('/P BMC q BT /F1 10 Tf 50 100 Td (AB) Tj ET Q EMC '+
  '/Span BMC q BT /F1 10 Tf 62 100 Td (CDE) Tj ET Q EMC');
 const plan=s.plan([s.edit({originalText:'AB',text:'new',coverRects:[{x:49.9,y:98,w:12.2,h:13}]})]);
 expect(output(plan)).toBe('newCDE');expect(plan.tail).toHaveLength(5);
});

for(const originalText of ['ABCDE','AB C DE','AB\nCDE'])test(`whitespace-insensitive matching accepts ${JSON.stringify(originalText)}`,async()=>{
 const s=await source('BT /F1 10 Tf 50 100 Td [(AB) -300 (CDE)] TJ ET');
 const plan=s.plan([s.edit({originalText,text:'new words',coverRects:[{x:49,y:98,w:36,h:13}]})]);
 expect(output(plan)).toBe('new words');
});

test('Han line breaks match without an inferred paragraph space',async()=>{
 const s=await source('BT /F1 10 Tf 14 TL 50 150 Td (AB) Tj 0 -14 Td (CD) Tj ET',
  '4 beginbfchar <41> <516c> <42> <5171> <43> <6570> <44> <636e> endbfchar');
 const plan=s.plan([s.edit({originalText:'公共\n数据',text:'共享资源',coverRects:[{x:49,y:148,w:14,h:13},{x:49,y:134,w:14,h:13}]})]);
 expect(plan.tail).toHaveLength(4);expect(output(plan)).toBe('共享资源');
});

test('a UI address may omit a selected superscript, but membership keeps it',async()=>{
 const s=await source('BT /F1 10 Tf 50 100 Td (AB) Tj /F1 7 Tf 1 0 0 1 62 104 Tm (2) Tj '+
  '/F1 10 Tf 1 0 0 1 66.2 100 Tm (CD) Tj ET');
 const plan=s.plan([s.edit({originalText:'AB CD',text:'new line',coverRects:[{x:49,y:98,w:31,h:14}]})]);
 expect(plan.tail).toHaveLength(5);expect(output(plan)).toBe('new line');
 const partial=s.plan([s.edit({originalText:'AB CD',text:'AX CD',coverRects:[{x:49,y:98,w:31,h:14}]})]);
 expect(output(partial)).toBe('AX2CD');
});

test('a UI address may omit the lowered selected letter in a stylized logo',async()=>{
 const s=await source('BT /F1 10 Tf 50 100 Td (CT) Tj 1 0 0 1 62 97.6 Tm (E) Tj '+
  '1 0 0 1 68 100 Tm (X) Tj ET');
 const plan=s.plan([s.edit({originalText:'CT X',text:'new title',coverRects:[{x:49,y:95,w:32,h:16}]})]);
 expect(plan.group.lines).toHaveLength(1);expect(plan.tail).toHaveLength(4);expect(output(plan)).toBe('new title');
});

test('compact matches choose the selected repeated occurrence and preserve earlier lines',async()=>{
 const s=await source('BT /F1 10 Tf 14 TL 50 150 Td [(AB) -300 (CDE)] TJ 0 -14 Td [(AB) -300 (CDE)] TJ ET');
 const plan=s.plan([s.edit({originalText:'ABCDE',text:'ABlong',coverRects:[{x:49,y:134,w:36,h:13}]})]);
 expect(plan.firstLine).toBe(1);expect(plan.tail).toHaveLength(5);expect(output(plan)).toBe('ABlong');
});

test('whitespace differences before the first edited line do not trim its replacement',async()=>{
 const s=await source('BT /F1 10 Tf 14 TL 50 150 Td [(AB) -300 (CDE)] TJ 0 -14 Td (FGHIJ) Tj ET');
 const plan=s.plan([s.edit({originalText:'ABCDE\nFGHIJ',text:'ABCDE\nnew words',coverRects:[{x:49,y:148,w:36,h:13},{x:49,y:134,w:36,h:13}]})]);
 expect(plan.firstLine).toBe(1);expect(plan.tail).toHaveLength(5);expect(output(plan)).toBe('new words');
});

test('compact offsets preserve a multi-Unicode glyph suffix and supplementary scalars',async()=>{
 const s=await source('BT /F1 10 Tf 50 100 Td (ABC) Tj ET',
  '3 beginbfchar <41> <d83dde00> <42> <006600660069> <43> <005a> endbfchar');
 const plan=s.plan([s.edit({originalText:'😀 f f',text:'new',coverRects:[{x:49,y:98,w:14,h:13}]})]);
 expect(output(plan)).toBe('newiZ');
});

test('leading and trailing whitespace edits map to the selected source boundaries',async()=>{
 const s=await source('BT /F1 10 Tf 40 100 Td ( AB CD ) Tj ET');
 const plan=s.plan([s.edit({originalText:' AB CD ',text:'AB CD',coverRects:[{x:39,y:98,w:44,h:13}]})]);
 expect(output(plan)).toBe('AB CD');
});

test('two edits share ownership when only one selection includes a superscript',async()=>{
 const s=await source('BT /F1 10 Tf 2 Tr 14 TL 50 100 Td (AB) Tj ET '+
  'BT /F1 7 Tf 2 Tr 62 104 Td (2) Tj ET BT /F1 10 Tf 2 Tr 66.2 100 Td (CD) Tj ET '+
  'BT /F1 10 Tf 2 Tr 50 86 Td (EFGH) Tj ET');
 const edits=[s.edit({originalText:'ABCD',text:'first title',coverRects:[{x:49,y:98,w:31,h:14}]}).overlay,
  s.edit({id:'second',originalText:'EFGH',text:'next words',coverRects:[{x:49,y:84,w:26,h:13}]}).overlay];
 const result=await applyContentTextEdits(s.page,edits,{stage5Reflow:false});
 expect(result.outcomes.map(o=>o.mode)).toEqual(['retypeset','retypeset']);
 expect(result.outcomes[0]!.retypeset?.paragraphBox).toEqual(result.outcomes[1]!.retypeset?.paragraphBox);
 expect(result.outcomes[0]!.retypeset?.lineCount).toBe(result.outcomes[1]!.retypeset?.lineCount);
 const stream=inspectRunPage(s.page);if(!stream.ok)throw Error(stream.reason);
 const text=readRetypesetSource(s.page,tokenizeContentStream(stream.bytes)).glyphs.map(g=>g.text).join('');
 expect(text.replace(/\s/gu,'')).toBe('firsttitlenextwords');
});

test('empty, overlapping and truly unmatched addresses still fail closed',async()=>{
 const s=await source('BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET');
 expect(()=>s.plan([s.edit({originalText:'  \n'})])).toThrow('empty source selection');
 expect(()=>s.plan([s.edit({originalText:'XYZ'})])).toThrow('user source text does not match addressed paragraph');
 expect(()=>s.plan([s.edit({originalText:'ABDE'})])).toThrow('user source text does not match addressed paragraph');
 expect(()=>s.plan([s.edit({originalText:'AB',coverRects:[{x:68,y:98,w:12,h:13}]})])).toThrow('user source text does not match addressed paragraph');
 expect(()=>s.plan([s.edit({coverRects:[{x:0,y:0,w:1,h:1}]})])).toThrow();
 expect(()=>s.plan([s.edit({originalText:'ABC'}),s.edit({id:'two',originalText:'BCD'})])).toThrow('overlapping edits in one paragraph');
});
