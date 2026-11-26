import {PDFDict,PDFName} from 'pdf-lib';
import {type1Fixture} from './type1Wiring.test-support';
import {nums,widthChar} from '../fontCoverage/fixtures/type1';
import {inspectRunPage,resolveRunFonts} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {streamReflowEvidence,type StreamReflowEvidence} from './reflowEvidence';
import type {ReflowCodeCluster} from './reflowTypes';

const rect=(y:number,h:number,w=300,advance=600)=>Uint8Array.from([...nums(0,advance),13,...nums(0,y),21,...nums(w,0),5,...nums(0,h),5,...nums(-w,0),5,9,14]);
export const tightRow=(y:number,text='gkgk',x=50)=>`BT /F1 10 Tf 9.9 TL ${x} ${y} Td (${text}) Tj ET `;
export async function rowLocalFixture(stream=tightRow(150)+tightRow(140.1),target=1,annot?:number[]){
 const f=await type1Fixture({stream,programOptions:{glyphs:{'.notdef':widthChar(0),space:widthChar(300),g:rect(-140,600),k:rect(0,930),A:rect(-140,600,100,302),B:rect(-140,600,100,302),Eacute:rect(0,1100)}}});
 const ctx=f.doc.context,widths=Array(170).fill(600);widths[0]=300;widths[65-32]=widths[66-32]=302;
 f.font.set(PDFName.of('FirstChar'),ctx.obj(32));f.font.set(PDFName.of('LastChar'),ctx.obj(201));f.font.set(PDFName.of('Widths'),ctx.obj(widths));
 f.font.set(PDFName.of('Encoding'),ctx.obj({Differences:[32,'space',65,'A','B',103,'g',107,'k',201,'Eacute']}));
 f.font.set(PDFName.of('ToUnicode'),ctx.register(ctx.flateStream('6 beginbfchar <20> <0020> <41> <0041> <42> <0042> <67> <0067> <6B> <006B> <C9> <00C9> endbfchar')));
 if(annot)f.page.node.set(PDFName.of('Annots'),ctx.obj([ctx.register(ctx.obj({Type:'Annot',Subtype:'Link',Rect:annot}))]));
 const s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);
 const fonts=resolveRunFonts(f.page),op=tokenizeContentStream(s.bytes).flatMap((o,i)=>o.operator==='Tj'?[i]:[])[target]!;
 return {...f,s,fonts,op,e:streamReflowEvidence(f.page,s.bytes,fonts,op)};
}
export function requireRowEvidence(f:Awaited<ReturnType<typeof rowLocalFixture>>):StreamReflowEvidence{
 if(!f.e.ok)throw Error(f.e.detail);return f.e;
}
export function replacement(e:StreamReflowEvidence,index:number,unicode:string):ReflowCodeCluster{
 const base=e.source[index]!,font=e.fonts.find(f=>f.objectId===base.fontObject)!,code=[...font.unicodeByCode].find(([,u])=>u===unicode)![0];
 const state=e.trace.shows.get(`${base.source!.opIndex}:${base.source!.itemIndex}`)!.before,ink=e.ink(font.resourceName,code,state);
 if(!ink)throw Error('missing replacement ink');
 return {...base,unicode,code:Uint8Array.of(code),advance:font.widthOf(code)*state.size/1000,ink:ink.box,glyph:ink.glyph,
  source:undefined,original:undefined,homeOp:base.source!.opIndex};
}
export const origins=(e:StreamReflowEvidence)=>e.source.map(t=>[t.original!.x,t.original!.y] as [number,number]);
export const fontDescriptor=(f:Awaited<ReturnType<typeof rowLocalFixture>>)=>f.font.lookup(PDFName.of('FontDescriptor'),PDFDict);
