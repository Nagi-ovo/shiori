import {expect,test} from 'bun:test';
import type {ContentTextOutcome} from './outcomes';
import {applyUprightColumnRetypesets} from './uprightColumn';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {readRetypesetSource,address} from './retypesetSource';
import {columnEdit,loadFont,pageColumns,verticalCorpusPage} from './uprightColumn.fixture.test';
import type {ColumnCell} from './uprightColumnPlan';

// Failure list for growth that moves the rest of a column or wraps:
// - later cells of the column left in place under the new text (overlap);
// - moved cells changing font, code or relative spacing, or moving by more
//   than one translation inside one destination column;
// - a second tier or another column's text moved;
// - wrapping into a column that already holds other text;
// - a wrapped column headed by a stop, comma, small kana or iteration mark;
// - rotated glyphs riding in the column (a Latin word, a dash) left behind;
// - growth refused before the cell plan is even tried (no regression).
type Columns=ReturnType<typeof pageColumns>['columns'];
async function run(id:string,index:number,pick:(columns:Columns)=>ColumnCell[],text:(s:string)=>string){
 const {page}=await verticalCorpusPage(id,index),{columns,box,source}=pageColumns(page),cells=pick(columns);
 const edit=columnEdit(cells,box,text),outcomes=new Map<string,ContentTextOutcome>();
 await applyUprightColumnRetypesets(page,[edit],outcomes,new Set(),{loadFont});
 const content=inspectRunPage(page);if(!content.ok)throw Error(content.reason);
 return{edit,cells,columns,before:source,after:readRetypesetSource(page,tokenizeContentStream(content.bytes)),outcome:outcomes.get(edit.id)};
}
const key=(g:{glyph:{fontName:string;code:number}})=>`${g.glyph.fontName}:${g.glyph.code}`;
/** Every untouched source glyph either stays exactly or moves by one of the
 * manifest's region translations; returns the translations actually used. */
function translations(r:Awaited<ReturnType<typeof run>>){
 const owned=new Set(r.cells.map(c=>address(c.glyph.glyph))),left=[...r.after.glyphs],used=new Map<string,number>();
 const regions=r.outcome?.mode==='retypeset'?r.outcome.retypeset.pushedRegions:[];
 for(const g of r.before.glyphs.filter(g=>!owned.has(address(g.glyph)))){
  const deltas=[{dx:0,dy:0},...regions.map(p=>({dx:p.after.x-p.before.x,dy:p.after.y-p.before.y}))];
  const hit=deltas.flatMap(d=>{const i=left.findIndex(a=>key(a)===key(g)&&Math.abs(a.x-g.x-d.dx)<1e-3&&Math.abs(a.y-g.y-d.dy)<1e-3);return i<0?[]:[{i,d}];})[0];
  expect(hit).toBeDefined();left.splice(hit!.i,1);
  const k=`${hit!.d.dx.toFixed(3)},${hit!.d.dy.toFixed(3)}`;used.set(k,(used.get(k)??0)+1);
 }
 return{used,added:left};
}
const startingWith=(prefix:string)=>(columns:Columns)=>{const k=columns.find(c=>c.map(x=>x.glyph.text).join('').startsWith(prefix))!;return k.slice(0,Array.from(prefix).length);};

test('growth inside a column moves the rest of that column down by one translation',async()=>{
 const r=await run('vert-lo-jp-rashomon',3,startingWith('る。本'),s=>s+'日本');
 expect(r.outcome).toMatchObject({mode:'retypeset',retypeset:{pushed:true}});
 const {used,added}=translations(r),moved=[...used].filter(([k])=>k!=='0.000,0.000');
 // One shared downward translation of two observed pitches; nothing sideways.
 expect(moved).toHaveLength(1);
 const [dx,dy]=moved[0]![0].split(',').map(Number);expect(dx).toBe(0);expect(dy).toBeCloseTo(-24,1);
 expect(moved[0]![1]).toBeGreaterThan(20);
 expect(added.map(g=>g.text).join('')).toBe('る。本日本');
},30_000);

test('a full last column wraps its overflow into the proved-empty next column',async()=>{
 const r=await run('vert-lo-jp-rashomon',2,c=>c.at(-1)!,s=>s+'についての補足');
 expect(r.outcome).toMatchObject({mode:'retypeset'});
 const {added}=translations(r),column=r.cells,cx=column[0]!.cx,em=column[0]!.em;
 const wrapped=added.filter(g=>g.x<cx-em);
 expect(wrapped.length).toBeGreaterThan(0);
 // The wrapped column starts at the band's top row, never with a forbidden mark.
 const head=wrapped.sort((a,b)=>b.y-a.y)[0]!;
 expect(head.y).toBeCloseTo(Math.max(...r.columns.map(k=>k[0]!.glyph.y)),1);
 expect(head.text).not.toMatch(/^[、。々ー]/u);
},30_000);

test('a column ending at the measure carries a forbidden head mark with the glyph before it',async()=>{
 const r=await run('vert-lo-jp-rashomon',0,c=>c.at(-1)!.slice(0,20),s=>s+'についての補足');
 expect(r.outcome).toMatchObject({mode:'retypeset'});
 const {used,added}=translations(r),cx=r.cells[0]!.cx,em=r.cells[0]!.em;
 const moved=[...used].filter(([k])=>k!=='0.000,0.000').map(([k])=>k.split(',').map(Number));
 // Tail cells move down in the column and, past the measure, into the next column.
 expect(moved.some(([dx])=>dx===0)).toBe(true);expect(moved.some(([dx])=>dx!<-em)).toBe(true);
 const after=[...r.after.glyphs].filter(g=>g.x<cx-em).sort((a,b)=>b.y-a.y);
 expect(after[0]!.text).not.toMatch(/^[、。々ー]/u);
 expect(added.map(g=>g.text).join('')).toBe(r.edit.text);
},30_000);

test('growth never pushes into a next column that holds other text',async()=>{
 const r=await run('vert-typst-jp-rashomon',0,startingWith('上は、この男'),s=>s+'についての補足');
 expect(r.outcome).toMatchObject({mode:'unsupported'});
 expect(r.outcome?.detail).toContain('flow: vertical-obstacle');
},30_000);
