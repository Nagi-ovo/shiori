import {PDFDict,PDFName} from 'pdf-lib';
import {fixture} from './fixtures.test-support';
import {cidCff} from '../fontCoverage/fixtures/cidCff';
export async function cffFixture(program=cidCff(),clip='49 65 33 50 re W n'){
 const f=await fixture(`q ${clip} BT /F1 10 Tf 14 TL 50 100 Td <00010001000100010001> Tj ET Q`),ctx=f.doc.context;
 const map=new Uint8Array(6);map[3]=1;map[5]=2;
 const descriptor=ctx.obj({Type:'FontDescriptor',FontName:'Tiny',Flags:4,FontBBox:[0,-9999,9999,9999],Ascent:100,Descent:0,CapHeight:100,ItalicAngle:0,StemV:80,
  FontFile2:ctx.register(ctx.flateStream(program))});
 const child=ctx.obj({Type:'Font',Subtype:'CIDFontType2',BaseFont:'Tiny',DW:600,FontDescriptor:ctx.register(descriptor),CIDToGIDMap:ctx.register(ctx.flateStream(map)),
  CIDSystemInfo:{Registry:'Adobe',Ordering:'Identity',Supplement:0}});
 const font=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict);
 for(const k of ['FirstChar','Widths'])font.delete(PDFName.of(k));
 font.set(PDFName.of('Subtype'),PDFName.of('Type0'));font.set(PDFName.of('BaseFont'),PDFName.of('Tiny'));font.set(PDFName.of('Encoding'),PDFName.of('Identity-H'));
 font.set(PDFName.of('DescendantFonts'),ctx.obj([ctx.register(child)]));
 font.set(PDFName.of('ToUnicode'),ctx.register(ctx.flateStream('2 beginbfchar <0001> <0041> <0002> <0042> endbfchar')));
 return{...f,font,child,descriptor,map};
}
