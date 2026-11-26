import {expect,test} from 'bun:test';
import type {ContentTextOutcome} from './outcomes';
import {PDFDict,PDFName} from 'pdf-lib';
import {bytes,fixture} from './fixtures.test-support';
import {applyUprightColumnRetypesets} from './uprightColumn';
import {columnEdit,loadFont,pageColumns} from './uprightColumn.fixture.test';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import {contains} from './regionProof/geometry';

// Failure list before retrying clip refusals:
// - a content-area clip prevents wrapping into an empty column inside it;
// - flow takes precedence over an already viable one-column fit;
// - wrapping escapes a narrow source clip or the page;
// - stationary ink/paint anywhere in the wrapped band is overlooked;
// - failed retries lose diagnostics or mutate the source/resources.
async function clippedColumn(kind:'content'|'tight'|'ink'|'paint'|'page',text='日本天地人日本天地人'){
 const clip={x:kind==='tight'?146:100,y:96,w:kind==='tight'?14:90,h:66};
 const column=(x:number)=>`BT /F1 10 Tf 1 0 0 1 ${x} 150 Tm (A) Tj 0 -12 Td (B) Tj 0 -12 Td (C) Tj 0 -12 Td (D) Tj 0 -12 Td (E) Tj ET`;
 const extra=kind==='ink'?'BT /F1 10 Tf 126 138 Td (X) Tj ET':kind==='paint'?'126 98 6 2 re f':'';
 const {page,doc}=await fixture(`q ${clip.x} ${clip.y} ${clip.w} ${clip.h} re W n ${column(150)} Q ${column(174)} ${extra}`);
 const font=page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict);
 font.set(PDFName.of('ToUnicode'),doc.context.register(doc.context.stream(bytes('6 beginbfchar <41> <65e5> <42> <672c> <43> <5929> <44> <5730> <45> <4eba> <58> <6708> endbfchar'))));
 if(kind==='page')page.setCropBox(140,0,160,200);
 const {columns,box}=pageColumns(page),cells=columns.find(c=>Math.abs(c[0]!.glyph.x-150)<.01)!;
 const edit=columnEdit(cells,box,()=>text),before=inspectRunPage(page),resources=page.node.Resources(),count=doc.context.enumerateIndirectObjects().length;
 const outcomes=new Map<string,ContentTextOutcome>();
 await applyUprightColumnRetypesets(page,[edit],outcomes,new Set(),{loadFont});
 return{page,doc,clip,edit,before,resources,count,outcome:outcomes.get(edit.id)};
}

test('a content-area clip permits flow into an empty next column after fitting fails',async()=>{
 const r=await clippedColumn('content');
 expect(r.outcome).toMatchObject({mode:'retypeset',retypeset:{lineCount:2,pushed:false}});
 const {source,columns,box}=pageColumns(r.page),replacement=columns.filter(c=>c[0]!.glyph.x<170).flat();
 expect(replacement.map(c=>c.glyph.text).join('')).toBe(r.edit.text);
 expect(replacement.some(c=>c.glyph.x<140)).toBe(true);
 for(const c of replacement){expect(contains(r.clip,box(c))).toBe(true);expect(c.glyph.state.fontSize).toBe(10);}
 expect(source.glyphs.filter(g=>g.x===174).map(g=>[g.text,g.y])).toEqual([['日',150],['本',138],['天',126],['地',114],['人',102]]);
});

test('a clip-constrained edit that fits stays in its original column',async()=>{
 const r=await clippedColumn('content','日本天地人日');
 expect(r.outcome).toMatchObject({mode:'retypeset',retypeset:{lineCount:1,pushed:false}});
 const {columns}=pageColumns(r.page),replacement=columns.filter(c=>c[0]!.glyph.x<170).flat();
 expect(replacement.map(c=>c.glyph.text).join('')).toBe(r.edit.text);
 expect(replacement.every(c=>Math.abs(c.cx-153)<.01&&c.glyph.state.fontSize>=8.5)).toBe(true);
});

for(const [kind,reason]of [['tight','vertical-clip:'],['ink','vertical-obstacle:'],['paint','vertical-obstacle:'],['page','vertical-crop-media:']]as const){
 test(`clip retries refuse a ${kind} obstruction without changing the page`,async()=>{
  const r=await clippedColumn(kind);
  expect(r.outcome).toMatchObject({mode:'unsupported'});
  expect(r.outcome?.detail).toContain('vertical-clip:');
  expect(r.outcome?.detail).toContain('; fit: vertical-clip:');
  expect(r.outcome?.detail).toContain(`; flow: ${reason}`);
  expect(inspectRunPage(r.page)).toEqual(r.before);
  expect(r.page.node.Resources()).toBe(r.resources);
  expect(r.doc.context.enumerateIndirectObjects()).toHaveLength(r.count);
 });
}
