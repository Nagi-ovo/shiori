import {expect,test} from 'bun:test';
import type {ContentTextOutcome} from './outcomes';
import {applyUprightColumnRetypesets} from './uprightColumn';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {readRetypesetSource} from './retypesetSource';
import {columnEdit,loadFont,pageColumns,verticalCorpusPage} from './uprightColumn.fixture.test';
import {interleavedColumnText} from './uprightColumnStray';

// Failure list for an overlay that interleaves a column with single cells
// of staggered neighbour columns:
// - a stray cell rewritten, moved or dropped;
// - an edit that changes a stray character applied to the column anyway;
// - an ambiguous interleaving (a stray equal to a column character next to
//   it) guessed instead of refused;
// - a selection split evenly between columns treated as one column;
// - the insertion point shifted by the removed stray characters.
test('the column edit drops strays only when they are unchanged and unambiguous',()=>{
 const columns=[Array.from('善い事をした報には'),['の'],['獄']];
 expect(interleavedColumnText('善い事をした報に の 獄は','善い事iをした報に の 獄は',columns)).toEqual({column:0,originalText:'善い事をした報には',text:'善い事iをした報には'});
 // An insertion just after the strays lands after the column cell before them.
 expect(interleavedColumnText('善い事をした報に の 獄は','善い事をした報に の 獄日は',columns)?.text).toBe('善い事をした報に日は');
 expect(interleavedColumnText('善い事をした報に の 獄は','善い事をした報に 獄は',columns)).toBeUndefined();
 expect(interleavedColumnText('善い事をした報に の 獄は','全く別の文',columns)).toBeUndefined();
 expect(interleavedColumnText('善い事をした報に の 獄は','善い事をした報に の 獄は',columns)).toBeUndefined();
 // "の" could be the stray or the column's own: no single reading.
 expect(interleavedColumnText('あののい','あのいX',[Array.from('あのい'),['の']])).toBeUndefined();
});

// Failure list for an overlay spread over several interleaved columns with
// no dominant one (a row-built overlay over staggered LuaTeX-ja columns):
// - two ways to split the text into top-down columns, one guessed;
// - an edit that changes characters of two columns (a swap) applied to one;
// - an insertion between cells of two columns given to either of them;
// - prefix-first and suffix-first diff alignments naming different columns;
// - a column of fewer than three cells treated as a provable column;
// - other columns' characters dropped, moved or rewritten.
test('an edit inside one of several interleaved columns addresses only that column',()=>{
 const columns=[Array.from('よる︒本'),Array.from('利用し'),['文']],o='よ 利る 用︒ し 文本';
 expect(interleavedColumnText(o,'日 利る 用︒ し 文本',columns)).toEqual({column:0,originalText:'よる︒本',text:'日る︒本'});
 expect(interleavedColumnText(o,' 利る 用︒ し 文本',columns)).toEqual({column:0,originalText:'よる︒本',text:'る︒本'});
 // Text appended after the last character continues that character's column.
 expect(interleavedColumnText(o,o+'補足',columns)).toEqual({column:0,originalText:'よる︒本',text:'よる︒本補足'});
 expect(interleavedColumnText(o,'よ 利る 日︒ し 文本',columns)).toEqual({column:1,originalText:'利用し',text:'利日し'});
});

test('an edit that two column readings explain differently is refused',()=>{
 const columns=[Array.from('よる︒本'),Array.from('利用し'),['文']],o='よ 利る 用︒ し 文本';
 // Swap across columns.
 expect(interleavedColumnText(o,' 利よる 用︒ し 文本',columns)).toBeUndefined();
 // Insertions between cells of two columns.
 expect(interleavedColumnText(o,'よi利る 用︒ し 文本',columns)).toBeUndefined();
 expect(interleavedColumnText(o,'よ 利iる 用︒ し 文本',columns)).toBeUndefined();
 // Prefix-first puts the new よ between よ and 利; suffix-first before よ.
 expect(interleavedColumnText(o,'よよ 利る 用︒ し 文本',columns)).toBeUndefined();
 // A one-cell column is not a provable column.
 expect(interleavedColumnText(o,'よ 利る 用︒ し 日本',columns)).toBeUndefined();
 // Two splits: the first あ belongs to either column.
 expect(interleavedColumnText('ああいう','ああいX',[Array.from('あいう'),['あ']])).toBeUndefined();
 expect(interleavedColumnText(o+'\n','日'+o.slice(1)+'\n',columns)).toBeUndefined();
});

test('an overlay with stray neighbour cells edits its column and leaves the strays',async()=>{
 const {page}=await verticalCorpusPage('vert-luatex-jp-tcy-2col',1),{columns,box,source}=pageColumns(page);
 const em=10,full=columns.filter(k=>k.length>=50&&Math.abs(k[0]!.em-9.96)<.1),own=full.at(-1)!.slice(0,12);
 // One cell each from the two columns to its right, on the rows of cell 8.
 const strays=full.slice(-3,-1).map(k=>k.reduce((a,c)=>Math.abs(c.glyph.y-own[8]!.glyph.y)<Math.abs(a.glyph.y-own[8]!.glyph.y)?c:a));
 expect(strays.every(c=>Math.abs(c.glyph.y-own[8]!.glyph.y)<em)).toBe(true);
 const edit=columnEdit([...own.slice(0,8),...strays,...own.slice(8)],box,s=>s),chars=Array.from(edit.originalText);
 const outcomes=new Map<string,ContentTextOutcome>();
 await applyUprightColumnRetypesets(page,[{...edit,text:chars.map((c,i)=>i===2?'日':c).join('')}],outcomes,new Set(),{loadFont});
 expect(outcomes.get(edit.id)).toMatchObject({mode:'retypeset'});
 const content=inspectRunPage(page);if(!content.ok)throw Error(content.reason);
 const after=readRetypesetSource(page,tokenizeContentStream(content.bytes));
 for(const s of strays)expect(after.glyphs.some(g=>g.glyph.code===s.glyph.glyph.code&&g.glyph.fontName===s.glyph.glyph.fontName&&Math.abs(g.x-s.glyph.x)<1e-3&&Math.abs(g.y-s.glyph.y)<1e-3)).toBe(true);
 expect(after.glyphs.some(g=>g.text==='日'&&Math.abs(g.y-own[2]!.glyph.y)<1e-3)).toBe(true);
 expect(source.glyphs.length).toBe(after.glyphs.length);
 // Changing a stray's character is not this column's edit.
 const again=await verticalCorpusPage('vert-luatex-jp-tcy-2col',1),o2=new Map<string,ContentTextOutcome>();
 await applyUprightColumnRetypesets(again.page,[{...edit,text:chars.map((c,i)=>i===8?'日':c).join('')}],o2,new Set(),{loadFont});
 expect(o2.get(edit.id)?.mode).not.toBe('retypeset');
},30_000);

// LuaTeX-ja page 2: the row-built overlay "よ 利る 用︒ し 文本" holds four
// cells of one column, three of the next and one of a third.
async function interleavedPage(){
 const {page}=await verticalCorpusPage('vert-luatex-jp-tcy-2col',2),{columns,box,source}=pageColumns(page);
 const at=(k:readonly (typeof columns)[number][number][],text:string)=>{for(let i=0;i+text.length<=k.length;i++)if(k.slice(i,i+text.length).map(c=>c.glyph.text).join('')===text)return k.slice(i,i+text.length);};
 const ai=columns.findIndex(k=>at(k,'よる︒本')),a=at(columns[ai]!,'よる︒本')!,b=at(columns[ai-1]!,'利用し')!,c=columns[ai-2]!.find(c=>Math.abs(c.glyph.y-a[2]!.glyph.y)<1)!;
 expect(Math.abs(a[0]!.glyph.y-b[0]!.glyph.y)<.01&&c.glyph.text==='文').toBe(true);
 const rows=[[a[0]!,b[0]!],[a[1]!,b[1]!],[a[2]!,b[2]!,c],[a[3]!]];
 return{page,source,cells:rows.flat(),box,a,b,c};
}
test('an overlay over three interleaved columns edits the one column its change lies in',async()=>{
 const {page,source,cells,box,a,b,c}=await interleavedPage(),edit=columnEdit(cells,box,s=>'日'+s.slice(1));
 const outcomes=new Map<string,ContentTextOutcome>();
 await applyUprightColumnRetypesets(page,[edit],outcomes,new Set(),{loadFont});
 expect(outcomes.get(edit.id)).toMatchObject({mode:'retypeset'});
 const content=inspectRunPage(page);if(!content.ok)throw Error(content.reason);
 const after=readRetypesetSource(page,tokenizeContentStream(content.bytes));
 for(const s of [...b,c,...a.slice(1)])expect(after.glyphs.some(g=>g.glyph.code===s.glyph.glyph.code&&g.glyph.fontName===s.glyph.glyph.fontName&&Math.abs(g.x-s.glyph.x)<1e-3&&Math.abs(g.y-s.glyph.y)<1e-3)).toBe(true);
 expect(after.glyphs.some(g=>g.text==='日'&&Math.abs(g.y-a[0]!.glyph.y)<1e-3)).toBe(true);
 expect(after.glyphs.length).toBe(source.glyphs.length);
},30_000);
test('a swap across interleaved columns is left to the paragraph path, never written as a column',async()=>{
 const {page,cells,box}=await interleavedPage(),edit=columnEdit(cells,box,s=>s[1]+s[0]+s.slice(2));
 const outcomes=new Map<string,ContentTextOutcome>();
 const handled=await applyUprightColumnRetypesets(page,[edit],outcomes,new Set(),{loadFont});
 expect(handled.has(edit.id)).toBe(false);expect(outcomes.get(edit.id)).toBeUndefined();
},30_000);
