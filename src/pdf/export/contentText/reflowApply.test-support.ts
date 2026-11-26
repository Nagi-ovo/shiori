import {PDFDocument,PDFName,PDFDict} from 'pdf-lib';
import {tinyTtf} from '../fontCoverage/fixtures/programs';
import {tinyType1,nums,widthChar} from '../fontCoverage/fixtures/type1';
import {reflowFixture} from './reflow.fixtures';
import {fontCoverageFromDict} from '../fontCoverage/pdfLibAdapter';
import {runResourceStamp} from '../contentStreamEdit/resourceStamp';

export async function spacingPage(stream='BT /F1 10 Tf 1 0 0 1 50 100 Tm (Sni) Tj ET'){
 const doc=await PDFDocument.create(),ctx=doc.context,page=doc.addPage([300,200]);
 const widths=Array(95).fill(500);widths[83-32]=1000;widths[97-32]=502;widths[110-32]=502;
 const font=ctx.register(ctx.obj({Type:'Font',Subtype:'TrueType',BaseFont:'Tiny',FirstChar:32,LastChar:126,Widths:widths,Encoding:'WinAnsiEncoding',
  ToUnicode:ctx.register(ctx.flateStream('1 beginbfrange <20> <7e> <0020> endbfrange')),
  FontDescriptor:ctx.register(ctx.obj({Type:'FontDescriptor',Flags:32,Ascent:800,Descent:-200,FontFile2:ctx.register(ctx.flateStream(tinyTtf({empty:[0]})))}))}));
 page.node.set(PDFName.of('Resources'),ctx.obj({Font:{F1:font}}));
 page.node.set(PDFName.of('Contents'),ctx.register(ctx.flateStream(stream)));
 return {doc,page};
}
export async function requestPage(){
 const f=reflowFixture(),doc=await PDFDocument.create(),ctx=doc.context,page=doc.addPage([600,800]);
 const entries=[...f.font.unicodeByCode],names=entries.map(([code,s])=>[code,`uni${s.codePointAt(0)!.toString(16).toUpperCase()}`] as const);
 const glyphs=Object.fromEntries(names.map(([,name])=>[name,Uint8Array.from([...nums(0,1000),13,...nums(100,0),21,...nums(400,0),5,...nums(0,800),5,...nums(-400,0),5,9,14])]));
 const p=tinyType1({glyphs:{'.notdef':widthChar(0),...glyphs}});
 const font=ctx.register(ctx.obj({Type:'Font',Subtype:'Type1',BaseFont:'Tiny',FirstChar:1,LastChar:entries.length,Widths:entries.map(()=>1000),
  Encoding:{Differences:names.flatMap(([code,name])=>[code,PDFName.of(name)])},
  ToUnicode:ctx.register(ctx.flateStream(`${entries.length} beginbfchar ${entries.map(([code,s])=>`<${code.toString(16).padStart(2,'0')}> <${s.codePointAt(0)!.toString(16)}>`).join(' ')} endbfchar`)),
  FontDescriptor:ctx.register(ctx.obj({Type:'FontDescriptor',FontName:'Tiny',Flags:4,FontBBox:[0,-200,1000,800],ItalicAngle:0,CapHeight:800,StemV:80,Ascent:800,Descent:-200,FontFile:ctx.register(ctx.flateStream(p.program,{Length1:p.length1,Length2:p.length2,Length3:p.length3}))}))}));
 page.node.set(PDFName.of('Resources'),ctx.obj({Font:{F1:font}}));page.node.set(PDFName.of('Contents'),ctx.register(ctx.flateStream(f.content)));
 const request=f.request,dependencyHash=runResourceStamp(page),objectId=font.toString();
 request.dependencyHash=dependencyHash;request.paragraph.dependencyHash=dependencyHash;request.paragraph.evidence.dependencyHash=dependencyHash;
 request.target.fontObject=objectId;
 for(const line of request.paragraph.lines){line.anchor.fontObject=objectId;for(const s of line.shows){s.source.fontObject=objectId;s.before.fontObject=objectId;s.after.fontObject=objectId;}}
 const coverage=fontCoverageFromDict(ctx.lookup(font,PDFDict));
 for(const ink of request.sourceInk){ink.source.fontObject=objectId;const op=request.paragraph.ops[ink.source.opIndex]!;
  const item=op.operands[0];if(item?.kind!=='string')throw Error('expected Tj fixture');
  ink.glyph=coverage.mappings!.get(item.bytes[ink.source.byteStart]!.toString(16).padStart(2,'0'))!.glyph;
 }
 return {...f,doc,page,request};
}
