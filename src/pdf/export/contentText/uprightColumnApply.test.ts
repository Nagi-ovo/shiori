import {expect,test} from 'bun:test';
import {applyContentTextEdits} from './apply';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {readRetypesetSource} from './retypesetSource';
import {columnEdit,loadFont,pageColumns,verticalCorpusPage} from './uprightColumn.fixture.test';

// Public path: the user selects one vertical column of a LibreOffice or Typst
// page (one placed glyph per cell) and swaps two characters. Before column
// addressing this refused with "user source text does not match addressed
// paragraph".
for(const id of ['vert-lo-jp-rashomon','vert-typst-tc-poetry','vert-lo-jp-2col'])test(`${id}: a vertical column edit is written, not refused`,async()=>{
 const {page}=await verticalCorpusPage(id),{columns,box}=pageColumns(page),cells=columns.find(c=>c.length>=8)!;
 const edit=columnEdit(cells,box,s=>Array.from(s).map((c,i,a)=>i===0?a[1]!:i===1?a[0]!:c).join(''));
 const result=await applyContentTextEdits(page,[edit],{loadFont});
 expect(result.outcomes[0]?.mode).not.toBe('unsupported');
 const content=inspectRunPage(page);if(!content.ok)throw Error(content.reason);
 const after=readRetypesetSource(page,tokenizeContentStream(content.bytes));
 // The column reads the new text top-down at the source column's centre.
 const cx=cells[0]!.cx,column=after.glyphs.filter(g=>Math.abs(g.x+(cells[0]!.width)/2-cx)<cells[0]!.em*.3&&g.y<=cells[0]!.glyph.y+.01&&g.y>=cells.at(-1)!.glyph.y-.01).sort((a,b)=>b.y-a.y);
 expect(column.map(g=>g.text).join('')).toBe(edit.text);
},30_000);
