import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {openPdfium} from '../../../../scripts/pdf-inplace/nativePdfium';
import {applyContentTextEdits} from './apply';
import {verticalFixture} from './vertical.fixture.test';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';

// Failure list for a hard break inside a selection of one WMode 1 column
// (an overlay builder can split consecutive cells of one column into lines):
// - the break is laid out as a column break, moving later cells one pitch
//   left, out of a mask drawn around the source column;
// - a break count that differs from the source is flattened anyway;
// - a non-final line that changes its character count is flattened, shifting
//   later cells to other source rows;
// - a break that empties a cell is flattened into a shorter column;
// - breaks across two affected source columns are flattened into one column.
const loadFont=(name:string)=>readFile(`src/assets/fonts/${name}`);
// One source column at pen x=210, cells 16pt from y=210 down to y=130.
const column={x:200,y:126,w:20,h:88};
const oneColumn=async(originalText:string,text:string)=>{
 const f=await verticalFixture();
 return {f,edit:{...f.edit,originalText,text,rect:column,coverRects:[column]}};
};
const refusesUnchanged=async(f:Awaited<ReturnType<typeof verticalFixture>>,edit:typeof f.edit,detail:string)=>{
 const before=inspectRunPage(f.page),count=f.doc.context.enumerateIndirectObjects().length;
 const result=await applyContentTextEdits(f.page,[edit],{loadFont});
 expect(result.outcomes[0]?.mode).toBe('unsupported');expect(result.outcomes[0]?.detail).toContain(detail);
 expect(inspectRunPage(f.page)).toEqual(before);expect(f.doc.context.enumerateIndirectObjects()).toHaveLength(count);
};

test('a break between consecutive cells of one column keeps every cell in that column',async()=>{
 const {f,edit}=await oneColumn('日本\n語かな','日新\n語かな');
 const native=openPdfium('vendor/pdfium/linux-x64/lib/libpdfium.so');
 try{
  const before=native.inspectPage(await f.doc.save(),0,true);
  const result=await applyContentTextEdits(f.page,[edit],{loadFont});
  expect(result.outcomes[0]).toMatchObject({mode:'retypeset',retypeset:{lineCount:1,overflowed:false}});
  const after=native.inspectPage(await f.doc.save(),0,true);
  expect(after.text.replace(/\s/gu,'')).toBe('日新語かな');
  // The unchanged cells after the break keep their source origins.
  for(const i of [2,3,4]){expect(after.glyphs[i]!.origin[0]).toBeCloseTo(before.glyphs[i]!.origin[0],3);expect(after.glyphs[i]!.origin[1]).toBeCloseTo(before.glyphs[i]!.origin[1],3);}
  expect(after.glyphs.every(g=>g.box[0]>=column.x&&g.box[2]<=column.x+column.w)).toBe(true);
 }finally{native.close();}
});

test('a substitute glyph before a one-column break lays out in place',async()=>{
 const {f,edit}=await oneColumn('日本\n語かな','é本\n語かな');
 const result=await applyContentTextEdits(f.page,[edit],{loadFont});
 expect(result.outcomes[0]).toMatchObject({mode:'retypeset',retypeset:{substituteFont:'NotoSansJP-Regular.otf',lineCount:1,overflowed:false}});
});

test('a non-final line that changes its count keeps the column break and refuses',async()=>{
 const {f,edit}=await oneColumn('日本\n語かな','日\n語かな');
 await refusesUnchanged(f,edit,'vertical-mask');
});

test('a break that empties a cell stays refused',async()=>{
 const {f,edit}=await oneColumn('日本\n語かな','\n語かな');
 await refusesUnchanged(f,edit,'vertical-mask');
});

test('a changed break count is not flattened',async()=>{
 const {f,edit}=await oneColumn('日本\n語かな','日本\n語\nかな');
 await refusesUnchanged(f,edit,'vertical-mask');
});

test('breaks across two affected source columns stay column breaks',async()=>{
 const f=await verticalFixture({stream:code=>`BT /V1 16 Tf 1 0 0 1 210 210 Tm ${code('日本語')} Tj 1 0 0 1 186 210 Tm ${code('かな')} Tj ET`});
 const box={x:170,y:150,w:50,h:64},edit={...f.edit,originalText:'日本語\nかな',text:'日新語\nかな',rect:box,coverRects:[box]};
 const result=await applyContentTextEdits(f.page,[edit],{loadFont});
 expect(result.outcomes[0]).toMatchObject({mode:'retypeset',retypeset:{lineCount:2}});
 const native=openPdfium('vendor/pdfium/linux-x64/lib/libpdfium.so');
 try{const after=native.inspectPage(await f.doc.save(),0,true);expect(after.glyphs.slice(3).every(g=>g.origin[0]<190)).toBe(true);}finally{native.close();}
});
