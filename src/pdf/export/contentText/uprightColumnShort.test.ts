import {expect,test} from 'bun:test';
import type {ContentTextOutcome} from './outcomes';
import {applyUprightColumnRetypesets} from './uprightColumn';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {readRetypesetSource,address} from './retypesetSource';
import {singleGlyphActualText} from './uprightColumnActualText';
import {loadFont,verticalCorpusPage} from './uprightColumn.fixture.test';
import {overlay} from './fixtures.test-support';
import {gridColumnProof,rowBrokenColumnEdit,type GridCell} from './uprightColumnShort';

// Failure list for a column too short for the stacked-selection rule:
// - two stacked line starts of horizontal text (next glyph on the line about
//   one em away) taken for a column;
// - an isolated stacked pair with no three-cell run anywhere taken for one;
// - a neighbour run on other rows, at another pitch or another size counted
//   as evidence;
// - a neighbour run used although a nearer glyph sits on the selected rows;
// - a run whose own rows hold horizontal neighbours counted as evidence;
// - cells of two columns, or a pitch tighter than 0.8 em, accepted;
// - an edit that adds or removes an overlay line break read as a row break.
const em=13,step=13,pitch=22;
const column=(x:number,from:number,n:number,size=em,s=step):GridCell[]=>Array.from({length:n},(_,i)=>({cx:x,y:from-i*s,em:size}));
const centres=(cells:readonly GridCell[])=>cells.map(c=>({cx:c.cx,y:c.y}));
test('a two-cell column on the rows of a stacked neighbour column is proved',()=>{
 const pair=column(200,780,2),right=column(200+pitch,780,12),left=column(200-pitch,780,12),page=[...pair,...right,...left];
 expect(gridColumnProof(pair,page,centres(page))).toBe(true);
 // The pair continuing a longer page column is proved by that column.
 const own=column(200,780,6);
 expect(gridColumnProof(own.slice(2,4),own,centres(own))).toBe(true);
});
test('stacked line starts of horizontal text are not a column',()=>{
 // Lines of six glyphs one em apart, one em leading: the left edge stacks.
 const lines=[0,1,2,3].flatMap(r=>Array.from({length:6},(_,i)=>({cx:100+i*em,y:780-r*step,em})));
 expect(gridColumnProof(lines.filter(c=>c.cx===100).slice(0,2),lines,centres(lines))).toBe(false);
 // A neighbour column whose rows hold a horizontal note is no evidence.
 const pair=column(200,780,2),right=column(200+pitch,780,12),note={cx:200+pitch+em,y:780-5*step};
 expect(gridColumnProof(pair,[...pair,...right],[...centres([...pair,...right]),note])).toBe(false);
});
test('a short column needs aligned evidence of its own size and pitch',()=>{
 const pair=column(200,780,2);
 expect(gridColumnProof(pair,pair,centres(pair))).toBe(false);
 for(const right of [column(200+pitch,780-step/2,12),column(200+pitch,780,12,em,step*1.2),column(200+pitch,780,12,em*.8,step),column(200+pitch,780,2)]){
  const page=[...pair,...right];expect(gridColumnProof(pair,page,centres(page))).toBe(false);
 }
 // A nearer glyph on a selected row hides the column beyond it.
 const right=column(200+pitch,780,12),stray={cx:200-em*1.5,y:780};
 expect(gridColumnProof(pair,[...pair,...right],[...centres([...pair,...right]),stray])).toBe(false);
 // A pitch tighter than 0.8 em and cells of two columns.
 const tight=column(200,780,2,em,em*.7),near=column(200+pitch,780,12,em,em*.7);
 expect(gridColumnProof(tight,[...tight,...near],centres([...tight,...near]))).toBe(false);
 expect(gridColumnProof([pair[0]!,{...pair[1]!,cx:200+pitch}],[...pair,...right],centres([...pair,...right]))).toBe(false);
});
test('overlay line breaks over one column are rows only when the edit keeps them',()=>{
 const e=overlay({originalText:'王\n維',text:'é\n維'});
 expect(rowBrokenColumnEdit(e)).toMatchObject({originalText:'王維',text:'é維'});
 expect(rowBrokenColumnEdit({...e,text:'é維'})).toBeUndefined();
 expect(rowBrokenColumnEdit({...e,text:'é\n維\n日'})).toBeUndefined();
});

// Browser-printed Type 3 pages: a paragraph's last column "か。" and a poem's
// author column "王維", each two cells beside full columns.
async function shortType3(id:string,text:string){
 const {page}=await verticalCorpusPage(id,id==='vert-browser-jp-2col'?1:0);
 const content=inspectRunPage(page);if(!content.ok)throw Error(content.reason);
 const ops=tokenizeContentStream(content.bytes),read=readRetypesetSource(page,ops,{},undefined,{flippedType3:true}),labels=singleGlyphActualText(ops,read.glyphs);
 const glyphs=read.glyphs.map(g=>({...g,text:labels.get(address(g.glyph))?.text??g.text}));
 const start=glyphs.findIndex((g,i)=>glyphs.slice(i,i+2).map(x=>x.text).join('')===text&&Math.abs(glyphs[i+1]!.x-g.x)<2);
 const cells=glyphs.slice(start,start+2);
 const covers=cells.map(g=>({x:g.x-.8,y:g.y-2,w:14.6,h:14.6}));
 return{page,cells,covers};
}
test('a two-cell Type 3 column split into overlay rows is written in place',async()=>{
 for(const [id,text]of [['vert-browser-tc-poetry','王維'],['vert-browser-jp-2col','か。']]as const){
  const {page,cells,covers}=await shortType3(id,text);
  const edit=overlay({originalText:`${text[0]}\n${text[1]}`,text:`日\n${text[1]}`,coverRects:covers,rect:covers[0]!,fontSize:13});
  const outcomes=new Map<string,ContentTextOutcome>();
  await applyUprightColumnRetypesets(page,[edit],outcomes,new Set(),{loadFont});
  expect(outcomes.get(edit.id)).toMatchObject({mode:'retypeset'});
  const content=inspectRunPage(page);if(!content.ok)throw Error(content.reason);
  const ops=tokenizeContentStream(content.bytes),after=readRetypesetSource(page,ops,{},undefined,{flippedType3:true}),labels=singleGlyphActualText(ops,after.glyphs);
  const at=(y:number)=>after.glyphs.filter(g=>Math.abs(g.y-y)<.01&&Math.abs(g.x-cells[0]!.x)<8).map(g=>labels.get(address(g.glyph))?.text??g.text);
  expect(at(cells[0]!.y)).toEqual(['日']);expect(at(cells[1]!.y)).toEqual([text[1]]);
  // A break the edit adds is a new column, which this rule never guesses.
  const again=(await shortType3(id,text)).page,o2=new Map<string,ContentTextOutcome>();
  await applyUprightColumnRetypesets(again,[{...edit,text:`日\n\n${text[1]}`}],o2,new Set(),{loadFont});
  expect(o2.get(edit.id)?.mode).not.toBe('retypeset');
 }
},60_000);
