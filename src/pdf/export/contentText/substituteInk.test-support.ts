import {PDFDict,PDFName} from 'pdf-lib';
import {fixture,overlay} from './fixtures.test-support';
import {type1Fixture} from './type1Wiring.test-support';
import {nums,widthChar} from '../fontCoverage/fixtures/type1';

export const sourceInkCases=['width-only-overhang','bbox-outside','bbox-inside','hull-inside','seac-no-bbox','seac-bbox-outside','seac-bbox-inside','whitespace-seac'] as const;
export type SourceInkCase=typeof sourceInkCases[number];
export const acceptsSourceInk=(name:SourceInkCase)=>['bbox-inside','hull-inside','seac-bbox-inside'].includes(name);
export async function sourceInkFixture(name:SourceInkCase){
 if(name==='width-only-overhang'||name.startsWith('bbox-')){
  const f=await fixture('BT /F1 10 Tf 50 100 Td (f) Tj ET'),ctx=f.doc.context;
  const font=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict);
  font.set(PDFName.of('BaseFont'),PDFName.of('Times-Italic'));
  font.set(PDFName.of('FirstChar'),ctx.obj(102));font.set(PDFName.of('Widths'),ctx.obj([278]));font.delete(PDFName.of('ToUnicode'));
  if(name!=='width-only-overhang')font.set(PDFName.of('FontDescriptor'),ctx.obj({FontBBox:[-200,-250,1000,1000],Ascent:1000,Descent:-250}));
  return {...f,edit:overlay({originalText:'f',text:'.',coverRects:[name==='bbox-inside'?{x:47.5,y:97,w:13,h:13.5}:{x:49.5,y:97,w:3.78,h:14}]})};
 }
 const hull=name==='hull-inside',space=name==='whitespace-seac';
 // Component A paints [-200,800] beyond the composite's 600-unit advance.
 const path=Uint8Array.from([...nums(-200,600),13,...nums(0,0),21,...nums(1000,0),5,...nums(0,700),5,...nums(-1000,0),5,9,14]);
 const composite=Uint8Array.from([...nums(-200,600),13,...nums(0,0,0,65,194),12,6]);
 const f=await type1Fixture(hull?{stream:'BT /F1 10 Tf 50 100 Td (A) Tj ET'}:{
  stream:`BT /F1 10 Tf 50 100 Td (${space?'BA':'A'}) Tj ET`,differences:[65,space?'space':'Aacute',66,'B'],
  programOptions:{glyphs:{'.notdef':widthChar(0),A:path,acute:widthChar(),[space?'space':'Aacute']:composite,B:widthChar()},fontBBox:[-200,0,800,700]},
 });
 const descriptor=f.font.lookup(PDFName.of('FontDescriptor'),PDFDict);
 if(hull||name==='seac-no-bbox')descriptor.delete(PDFName.of('FontBBox'));
 else descriptor.set(PDFName.of('FontBBox'),f.doc.context.obj([-200,0,800,700]));
 f.font.delete(PDFName.of('ToUnicode'));
 if(hull)f.font.set(PDFName.of('Encoding'),PDFName.of('WinAnsiEncoding'));
 // Without Differences, the hull case uses the program's StandardEncoding.
 const wide=name==='seac-bbox-inside';
 return {...f,edit:overlay({originalText:space?'B ':hull?'A':'Á',text:'X',coverRects:[wide?{x:47.5,y:97,w:11,h:14}:{x:49,y:97,w:space?14:8,h:14}]})};
}
