import {PDFDict,PDFDocument,PDFName} from 'pdf-lib';
import {tinyType1,nums,widthChar,type TinyType1Options} from '../fontCoverage/fixtures/type1';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import type {PageRunPlan} from '../contentStreamEdit/pageRunPlan';

// Original filled outlines, also suitable for an independent native export probe.
const rect=(w:number,h:number)=>Uint8Array.from([...nums(0,600),13,...nums(0,0),21,...nums(w,0),5,...nums(0,h),5,...nums(-w,0),5,9,14]);
export async function type1Fixture(options:{stream?:string;widths?:number[];differences?: (number|string)[];brokenProgram?:boolean;programOptions?:TinyType1Options}={}) {
  const doc=await PDFDocument.create(),ctx=doc.context,page=doc.addPage([300,200]);
  const program=tinyType1({glyphs:{'.notdef':widthChar(0),A:rect(400,700),B:rect(300,500),C:rect(200,600)},...options.programOptions});
  const descriptor=ctx.register(ctx.obj({Type:'FontDescriptor',FontName:'Tiny',Flags:1,FontBBox:[0,0,600,700],Ascent:700,Descent:-200,CapHeight:700,ItalicAngle:0,StemV:80,
    FontFile:ctx.register(ctx.flateStream(options.brokenProgram?new TextEncoder().encode('%!PS invalid Type1'):program.program,
      {Length1:program.length1,Length2:program.length2,Length3:program.length3}))}));
  const font=ctx.obj({Type:'Font',Subtype:'Type1',BaseFont:'Tiny',FirstChar:65,LastChar:67,Widths:options.widths??[600,600,600],FontDescriptor:descriptor,
    ...(options.differences?{Encoding:{Differences:options.differences}}:{}),
    ToUnicode:ctx.register(ctx.flateStream('3 beginbfchar <41> <0041> <42> <0042> <43> <0043> endbfchar'))});
  const ref=ctx.register(font);
  page.node.set(PDFName.of('Resources'),ctx.obj({Font:{F1:ref}}));
  page.node.set(PDFName.of('Contents'),ctx.register(ctx.flateStream(options.stream??'BT /F1 10 Tf 50 100 Td (AB) Tj ET')));
  const source=inspectRunPage(page);if(!source.ok)throw Error(source.reason);
  const plan=(replacement:string):PageRunPlan=>({sourceHash:source.sourceHash,allowExistingCodePermutation:true,edits:[{
    fontResource:'F1',fontObject:ref.toString(),opIndex:3,itemIndex:-1,byteStart:0,byteEnd:2,expected:Uint8Array.of(65,66),replacement,
  }]});
  return {doc,page,font,ref,source,plan,fonts:page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict)};
}
