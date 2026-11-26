import {expect,test} from 'bun:test';
import {PDFDict,PDFName} from 'pdf-lib';
import {openPdfium} from '../pdf-inplace/nativePdfium';
import {verticalFixture} from '../../src/pdf/export/contentText/vertical.fixture.test';
import {identityVColumnOwnership} from './verticalColumnOracle';
import {assertRetypesetStreamIdentity,retypesetSourceOwnership} from './retypesetStreamOracle';
import {compareRetypesetNativePages} from './retypesetOracle';
import {applyContentTextEdits} from '../../src/pdf/export/contentText/apply';
import {readFile} from 'node:fs/promises';

// Failure list for the oracle's short Identity-V column reading, from saved
// native glyphs and the source font dictionaries alone:
// - horizontal text (Identity-H) owned as a column;
// - a program shared with a horizontal Type0 resource vouched for by its
//   vertical twin;
// - one cell, which has no stacking evidence;
// - cells that skip a row (pitch differs from the cell height);
// - cells of two columns, or two font programs;
// - a glyph on a selected row nearer than 1.3 pitches (interleaved text).
const native=()=>openPdfium('vendor/pdfium/linux-x64/lib/libpdfium.so');
const read=async(f:Awaited<ReturnType<typeof verticalFixture>>)=>{const n=native();try{return n.inspectPage(await f.doc.save(),0,true).glyphs;}finally{n.close();}};

test('two consecutive Identity-V cells are owned as one column at the cell pitch',async()=>{
 const f=await verticalFixture(),glyphs=await read(f),pair=glyphs.slice(2,4);
 const owned=identityVColumnOwnership(f.page,pair,glyphs);
 expect(owned?.pitch).toBeCloseTo(16,3);expect(owned?.map(g=>g.text).join('')).toBe('語か');
});

test('the oracle entry point owns a two-cell column with no three-cell run around it',async()=>{
 // As 案と between TCY runs: no stacked run of three supports the grid read.
 const f=await verticalFixture({text:'語か'}),glyphs=await read(f),box={x:200,y:170,w:20,h:44};
 const owned=retypesetSourceOwnership(f.page,glyphs,{originalText:'語\nか',text:'é\nか',coverRects:[box]});
 expect(owned.map(g=>g.text).join('')).toBe('語か');expect((owned as {pitch?:number}).pitch).toBeCloseTo(16,3);
});

test('an Identity-H font, or a program also shown horizontally, owns no column',async()=>{
 const f=await verticalFixture(),glyphs=await read(f),pair=glyphs.slice(2,4);
 f.raw.set(PDFName.of('Encoding'),PDFName.of('Identity-H'));
 expect(identityVColumnOwnership(f.page,pair,glyphs)).toBeUndefined();
 const g=await verticalFixture(),twin=g.raw.clone();twin.set(PDFName.of('Encoding'),PDFName.of('Identity-H'));
 g.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).set(PDFName.of('H1'),g.doc.context.register(twin));
 const again=await read(g);
 expect(identityVColumnOwnership(g.page,again.slice(2,4),again)).toBeUndefined();
});

test('one cell, a skipped row, or a crowded row owns no column',async()=>{
 const f=await verticalFixture(),glyphs=await read(f);
 expect(identityVColumnOwnership(f.page,glyphs.slice(2,3),glyphs)).toBeUndefined();
 expect(identityVColumnOwnership(f.page,[glyphs[1]!,glyphs[3]!],glyphs)).toBeUndefined();
 const g=await verticalFixture({stream:code=>`BT /V1 16 Tf 1 0 0 1 210 210 Tm ${code('日本語かな')} Tj 1 0 0 1 194 178 Tm ${code('日')} Tj ET`}),crowded=await read(g);
 expect(identityVColumnOwnership(g.page,crowded.slice(2,4),crowded)).toBeUndefined();
});

test('cells of two columns own no column',async()=>{
 const f=await verticalFixture({stream:code=>`BT /V1 16 Tf 1 0 0 1 210 210 Tm ${code('日本')} Tj 1 0 0 1 180 194 Tm ${code('語かな')} Tj ET`}),glyphs=await read(f);
 expect(identityVColumnOwnership(f.page,glyphs.slice(1,3),glyphs)).toBeUndefined();
});

test('a substitute cell in a two-cell column passes the native and stream comparison at the column anchor',async()=>{
 const f=await verticalFixture({text:'語か'}),bytes=await f.doc.save(),box={x:200,y:170,w:20,h:44};
 const edit={...f.edit,originalText:'語\nか',text:'é\nか',rect:box,coverRects:[box]},n=native();
 try{
  const before=n.inspectPage(bytes,0,true),owned=retypesetSourceOwnership(f.page,before.glyphs,edit);
  const {PDFDocument}=await import('pdf-lib'),source=await PDFDocument.load(bytes);
  const result=await applyContentTextEdits(f.page,[edit],{loadFont:name=>readFile(`src/assets/fonts/${name}`)});
  const outcome=result.outcomes[0]!;expect(outcome.mode).toBe('retypeset');
  const after=n.inspectPage(await f.doc.save(),0,true);
  const checked=compareRetypesetNativePages(before,after,edit,outcome.mode==='retypeset'?outcome.retypeset:undefined,owned);
  expect(checked.replacementGlyphs).toBe(2);
  expect(assertRetypesetStreamIdentity(source.getPage(0),f.page,owned)).toBe(0);
 }finally{n.close();}
});
