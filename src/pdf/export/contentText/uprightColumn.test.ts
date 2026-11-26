import {expect,test} from 'bun:test';
import fontkit from '@pdf-lib/fontkit';
import {PDFDict,PDFName} from 'pdf-lib';
import type {ContentTextOutcome} from './outcomes';
import {applyUprightColumnRetypesets} from './uprightColumn';
import {uprightColumnSelection} from './uprightColumnPlan';
import {selectRetypeset} from './retypesetPlan';
import {address} from './retypesetSource';
import {fixture,overlay} from './fixtures.test-support';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {readRetypesetSource} from './retypesetSource';
import {fontInputFromDict} from '../fontCoverage/pdfLibAdapter';
import {cffDefaultGlyphSpace,withoutIdentityFdMatrices} from './cffMatrices';
import {columnEdit,loadFont,pageColumns,verticalCorpusPage} from './uprightColumn.fixture.test';
import {stackedColumnOwnership} from '../../../../scripts/pdf-corpus/retypesetOracle';

// Failure list: a horizontal line or multi-line horizontal paragraph routed
// into the column path; untouched glyphs moving or changing font/code; new
// glyphs off the source cells; punctuation drawn with its horizontal form; a
// vertical-alternate scalar the source never shows accepted; a gap inside the
// selected column (growth into later cells: uprightColumnFlow.test.ts); a CFF FD matrix rewrite
// applied when the combined transform would change; oracle column ownership
// accepting horizontal text.
async function run(id:string,pick:(columns:ReturnType<typeof pageColumns>['columns'])=>ReturnType<typeof pageColumns>['columns'][number],text:(s:string)=>string,index=0){
 const {page}=await verticalCorpusPage(id,index),{columns,box,source}=pageColumns(page),cells=pick(columns);
 const edit=columnEdit(cells,box,text),outcomes=new Map<string,ContentTextOutcome>(),accepted=new Set<string>();
 const handled=await applyUprightColumnRetypesets(page,[edit],outcomes,accepted,{loadFont});
 return{page,edit,cells,before:source,handled,outcome:outcomes.get(edit.id)};
}
function readBack(page:Parameters<typeof readRetypesetSource>[0]){
 const content=inspectRunPage(page);if(!content.ok)throw Error(content.reason);
 return readRetypesetSource(page,tokenizeContentStream(content.bytes));
}
const body=(columns:ReturnType<typeof pageColumns>['columns'])=>columns.find(c=>c.length>=20)!;

for(const id of ['vert-lo-jp-rashomon','vert-typst-jp-rashomon'])test(`${id}: a same-length column edit keeps every other glyph and lands on source cells`,async()=>{
 const r=await run(id,body,s=>Array.from(s).map((c,i)=>i===1?'日':c).join(''));
 expect(r.handled.has(r.edit.id)).toBe(true);
 expect(r.outcome).toMatchObject({mode:'retypeset',fidelity:'approximate'});
 const after=readBack(r.page),owned=new Set(r.cells.map(c=>address(c.glyph.glyph)));
 const key=(g:{glyph:{fontName:string;code:number};x:number;y:number})=>`${g.glyph.fontName}:${g.glyph.code}:${g.x.toFixed(3)}:${g.y.toFixed(3)}`;
 const remaining=new Map<string,number>();for(const g of after.glyphs)remaining.set(key(g),(remaining.get(key(g))??0)+1);
 for(const g of r.before.glyphs.filter(g=>!owned.has(address(g.glyph)))){const k=key(g);expect(remaining.get(k)).toBeGreaterThan(0);remaining.set(k,remaining.get(k)!-1);}
 const added=after.glyphs.filter(g=>(remaining.get(key(g))??0)>0);
 expect(added.map(g=>g.text).join('')).toBe(r.edit.text);
 // Same-width CJK keeps each source cell's origin exactly.
 for(const [i,g]of added.entries()){expect(g.y).toBeCloseTo(r.cells[i]!.glyph.y,4);expect(g.x).toBeCloseTo(r.cells[i]!.glyph.x,4);}
},30_000);

test('observed column punctuation is reused with its source code',async()=>{
 const r=await run('vert-lo-jp-rashomon',body,s=>s.replace(/^(.)(.)/u,'$2$1'));
 expect(r.outcome?.mode).toBe('retypeset');
 const comma=r.cells.find(c=>c.glyph.text==='、')!,after=readBack(r.page);
 expect(after.glyphs.filter(g=>g.text==='、').every(g=>g.glyph.code===comma.glyph.glyph.code&&g.glyph.fontName===comma.glyph.glyph.fontName)).toBe(true);
},30_000);

test('a vertical-alternate scalar that no source column shows is refused precisely',async()=>{
 const r=await run('vert-lo-jp-rashomon',body,s=>'「'+s.slice(1));
 expect(r.outcome).toMatchObject({mode:'unsupported',reason:'unsupported-vertical-writing'});
 expect(r.outcome?.detail).toContain('needs a vertical alternate');
},30_000);

test('a selection with a gap inside its column is refused',async()=>{
 const {page}=await verticalCorpusPage('vert-lo-jp-rashomon'),{columns,box}=pageColumns(page),column=body(columns);
 const cells=[...column.slice(0,4),...column.slice(5,9)],edit=columnEdit(cells,box,s=>s);
 const outcomes=new Map<string,ContentTextOutcome>();await applyUprightColumnRetypesets(page,[{...edit,text:edit.originalText.replace(/^./u,'日')}],outcomes,new Set(),{loadFont});
 expect(outcomes.get(edit.id)?.detail).toContain('discontiguous');
},30_000);

test('horizontal text never routes into the column path',async()=>{
 const f=await fixture('BT /F1 10 Tf 50 100 Td (ABCDE) Tj 0 -12 Td (FGHIJ) Tj 0 -12 Td (KLMNO) Tj ET');
 const source=readBack(f.page),edit=overlay({originalText:'ABCDE\nFGHIJ\nKLMNO',text:'ABXDE\nFGHIJ\nKLMNO',coverRects:[{x:48,y:70,w:36,h:42}]});
 expect(uprightColumnSelection(source.glyphs,selectRetypeset(source.glyphs,edit),source.fonts,edit)).toBeUndefined();
 // One scalar per line stacks like a column, yet its single-line text order
 // is not the overlay's line-separated source, so it stays horizontal.
 const g=await fixture('BT /F1 10 Tf 50 100 Td (A) Tj 0 -12 Td (B) Tj 0 -12 Td (C) Tj ET'),s2=readBack(g.page);
 const e2=overlay({originalText:'A\nB\nC',text:'X\nB\nC',coverRects:[{x:48,y:70,w:12,h:42}]});
 expect(uprightColumnSelection(s2.glyphs,selectRetypeset(s2.glyphs,e2),s2.fonts,e2)).toBeUndefined();
});

test('CFF FD identity matrices are rewritten only when the combined transform is unchanged',async()=>{
 const {page}=await verticalCorpusPage('vert-typst-jp-rashomon');
 const raw=page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('f0'),PDFDict),program=fontInputFromDict(raw).program!;
 expect(cffDefaultGlyphSpace(program)).toBe(true);
 const copy=withoutIdentityFdMatrices(program)!;expect(copy.length).toBe(program.length);
 const head=new Uint8Array(54);new DataView(head.buffer).setUint16(18,1000);
 // A FD with a non-identity matrix changes the transform and is left alone.
 const scaled=program.slice(),at=findFdMatrix(program);expect(at).toBeGreaterThan(0);scaled[at]=141; // 1 -> 2
 expect(withoutIdentityFdMatrices(scaled)).toBeUndefined();expect(cffDefaultGlyphSpace(scaled)).toBe(false);
 expect(fontkit).toBeDefined();
});
function findFdMatrix(b:Uint8Array){
 // An identity FD matrix encodes as 140 139 139 140 139 139 12 7.
 for(let i=0;i+8<=b.length;i++)if([140,139,139,140,139,139,12,7].every((v,k)=>b[i+k]===v))return i;
 return -1;
}

test('oracle column ownership accepts stacked columns and rejects a baseline run',()=>{
 const col=[0,1,2,3].map(i=>({text:'日',origin:[100,700-12*i]})),next=[0,1,2].map(i=>({text:'本',origin:[80,700-12*i]}));
 expect(stackedColumnOwnership([...col,...next])).toHaveLength(7);
 expect(stackedColumnOwnership([0,1,2,3].map(i=>({text:'A',origin:[100+6*i,700]})))).toBeUndefined();
 expect(stackedColumnOwnership([...col,{text:'X',origin:[120,600]}])).toBeUndefined();
});

test('a Latin or digit pair in an upright column is refused as tate-chu-yoko',async()=>{
 const r=await run('vert-lo-jp-rashomon',body,s=>'12'+s.slice(2));
 expect(r.outcome).toMatchObject({mode:'unsupported'});expect(r.outcome?.detail).toContain('tate-chu-yoko');
},30_000);
