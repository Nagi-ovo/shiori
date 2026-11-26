import {expect,test} from 'bun:test';
import type {ContentTextOutcome} from './outcomes';
import {applyUprightColumnRetypesets} from './uprightColumn';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {readRetypesetSource} from './retypesetSource';
import {columnEdit,loadFont,pageColumns,verticalCorpusPage} from './uprightColumn.fixture.test';
import {columnUnits,tcyEvidence} from './uprightColumnTcy';
import {uprightScale,type ColumnCell} from './uprightColumnPlan';

// Failure list for a tate-chu-yoko unit in an upright column:
// - a Latin/digit run stacked as upright glyphs, or split across rows;
// - a run laid on a page that shows no such cell (no proof of size, face or
//   baseline), or in a face that cannot encode it;
// - a run wider than any cell the source shows spilling across columns;
// - the run off the column centre or off the observed baseline offset;
// - the unit splitter merging a run with CJK or splitting a run;
// - a flow that wraps the run into the next column stacking it, splitting it
//   across rows or columns, or shifting the cells that follow it.
type Columns=ReturnType<typeof pageColumns>['columns'];
const cjkColumn=(columns:Columns)=>columns.find(k=>k.length>=20&&k.every(c=>/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|[、。︑︒]/u.test(c.glyph.text??'')))!.slice(0,8);
async function run(id:string,index:number,text:(s:string)=>string,pick=cjkColumn){
 const {page}=await verticalCorpusPage(id,index),{columns,box,source}=pageColumns(page);
 const cells=pick(columns);
 const all=source.glyphs.flatMap(g=>{const font=source.fonts.find(f=>f.resourceName===g.glyph.fontName),s=uprightScale(g.state);if(!font||!s)return[];return[{glyph:g,font,cx:g.x+font.widthOf(g.glyph.code)*g.state.fontSize/1000*s.x/2,em:g.state.fontSize*s.y,width:font.widthOf(g.glyph.code)*g.state.fontSize/1000*s.x} satisfies ColumnCell];});
 const edit=columnEdit(cells,box,text),outcomes=new Map<string,ContentTextOutcome>();
 await applyUprightColumnRetypesets(page,[edit],outcomes,new Set(),{loadFont});
 const content=inspectRunPage(page);if(!content.ok)throw Error(content.reason);
 return{cells,edit,evidence:tcyEvidence(all),after:readRetypesetSource(page,tokenizeContentStream(content.bytes)),outcome:outcomes.get(edit.id)};
}

test('column units keep a Latin or digit run together and split everything else',()=>{
 expect(columnUnits('令和12年ABCの1字')).toEqual(['令','和','12','年','ABC','の','1','字']);
 expect(columnUnits('日\n本')).toEqual(['日','\n','本']);
});

test('a digit pair lands as one observed tate-chu-yoko cell',async()=>{
 const r=await run('vert-typst-jp-tcy-2col',0,s=>Array.from(s).map((c,i)=>i===2?'12':c).join(''));
 expect(r.evidence.length).toBeGreaterThan(0);
 expect(r.outcome).toMatchObject({mode:'retypeset'});
 const one=r.after.glyphs.find(g=>g.text==='1'&&Math.abs(g.y-r.cells[2]!.glyph.y)<2)!,two=r.after.glyphs.find(g=>g.text==='2'&&g.y===one.y&&g.x>one.x)!;
 expect(one).toBeDefined();expect(two).toBeDefined();
 const proof=r.evidence.find(e=>e.font.resourceName===one.glyph.fontName)!;
 // Same baseline, side by side, centred on the column, at the observed offset.
 expect(one.y).toBeCloseTo(r.cells[2]!.glyph.y+proof.offset,3);
 const width=(g:typeof one)=>proof.font.widthOf(g.glyph.code)*g.state.fontSize/1000*uprightScale(g.state)!.x;
 expect(two.x).toBeCloseTo(one.x+width(one),3);
 expect((one.x+two.x+width(two))/2).toBeCloseTo(r.cells[2]!.cx,2);
 // The following cells keep their rows: the unit takes exactly one.
 expect(r.after.glyphs.some(g=>g.text===r.cells[3]!.glyph.text&&Math.abs(g.y-r.cells[3]!.glyph.y)<1e-3)).toBe(true);
},30_000);

test('a flow wraps a digit pair into the next column as one row and the tail keeps its rows',async()=>{
 // The last upper-tier column is full: growth in its head pushes its tail
 // (a flow, not a cell plan), and the pair is the first unit past the measure.
 let column:ColumnCell[]=[];
 const r=await run('vert-typst-jp-tcy-2col',0,s=>s+column.slice(3,-1).map(c=>c.glyph.text).join('')+'12',columns=>{
  column=columns.find(k=>k.map(c=>c.glyph.text).join('').startsWith('透き徹'))!;return column.slice(0,3);
 });
 expect(r.outcome).toMatchObject({mode:'retypeset',retypeset:{pushed:true,lineCount:2}});
 const cx=r.cells[0]!.cx,em=r.cells[0]!.em,top=column[0]!.glyph.y,step=r.cells[0]!.glyph.y-r.cells[1]!.glyph.y;
 const wrapped=r.after.glyphs.filter(g=>g.x<cx-em&&g.y>column.at(-1)!.glyph.y-em*.5).sort((a,b)=>b.y-a.y||a.x-b.x);
 // The pair heads the wrapped column on one baseline, side by side, in the
 // face of an observed tate-chu-yoko cell, at that cell's baseline offset.
 const [one,two]=wrapped;
 expect([one!.text,two!.text]).toEqual(['1','2']);expect(two!.y).toBe(one!.y);
 const proof=r.evidence.find(e=>e.font.resourceName===one!.glyph.fontName)!;
 expect(proof).toBeDefined();expect(two!.glyph.fontName).toBe(proof.font.resourceName);
 expect(one!.y).toBeCloseTo(top+proof.offset,3);
 const width=(g:typeof one)=>proof.font.widthOf(g!.glyph.code)*g!.state.fontSize/1000*uprightScale(g!.state)!.x;
 expect(two!.x).toBeCloseTo(one!.x+width(one),3);
 // The tail follows one row below the pair, in source order and spacing.
 const tail=wrapped.slice(2),source=column.slice(3);
 expect(tail.map(g=>g.text).join('')).toBe(source.map(c=>c.glyph.text).join(''));
 expect(tail[0]!.y).toBeCloseTo(top-step,3);
 for(let i=1;i<tail.length;i++)expect(tail[i-1]!.y-tail[i]!.y).toBeCloseTo(source[i-1]!.glyph.y-source[i]!.glyph.y,3);
 expect((one!.x+two!.x+width(two))/2).toBeCloseTo(tail[0]!.x+width(tail[0])/2,0);
},30_000);

test('a run wider than any observed cell is refused by name',async()=>{
 const r=await run('vert-typst-jp-tcy-2col',0,s=>s.slice(0,2)+'1217121712'+s.slice(3));
 expect(r.outcome).toMatchObject({mode:'unsupported'});expect(r.outcome?.detail).toContain('wider than any tate-chu-yoko cell');
},30_000);

test('a producer that pads its cells off the row grid gives no proof',async()=>{
 // LuaTeX-ja sets its digit pairs with extra space above and below, so a
 // cell there does not take exactly one row of the column.
 const r=await run('vert-luatex-jp-tcy-2col',1,s=>s.slice(0,2)+'12'+s.slice(3));
 expect(r.evidence).toEqual([]);
 expect(r.outcome).toMatchObject({mode:'unsupported'});expect(r.outcome?.detail).toContain('no tate-chu-yoko cell');
},30_000);

test('a page that shows no upright tate-chu-yoko cell refuses a run',async()=>{
 // LibreOffice draws its digit pairs rotated in a separate small face.
 const r=await run('vert-lo-jp-rashomon',0,s=>'12'+s.slice(2));
 expect(r.evidence).toEqual([]);
 expect(r.outcome).toMatchObject({mode:'unsupported'});expect(r.outcome?.detail).toContain('tate-chu-yoko');
},30_000);
