import {type1Fixture} from './type1Wiring.test-support';
import {widthChar,nums} from '../fontCoverage/fixtures/type1';
import {PDFName} from 'pdf-lib';
export const regionRows=['S i i i i ','S i i i i ','S i'];
export const regionStream=(tagged=false,bridge='')=>regionRows.map((s,i)=>`${tagged?`q /P <</MCID ${i}>> BDC /Span BMC `:''}BT /F1 10 Tf 0 Tc 0 Tw 100 Tz 0 Ts 14 TL 50 ${150-i*14} Td (${s}) Tj ET${tagged?' EMC EMC Q':''}${i===0?bridge:''}`).join(' ');
export async function type1RegionPage(){
 const rect=Uint8Array.from([...nums(0,600),13,...nums(0,0),21,...nums(300,0),5,...nums(0,700),5,...nums(-300,0),5,9,14]);
 const f=await type1Fixture({stream:['AB AB AB ','AB AB AB ','AB '].map((s,i)=>`BT /F1 10 Tf 14 TL 50 ${150-i*14} Td (${s}) Tj ET`).join(' '),programOptions:{glyphs:{'.notdef':widthChar(0),A:rect,B:rect,space:widthChar(300)}}});
 const ctx=f.doc.context;f.font.set(PDFName.of('FirstChar'),ctx.obj(32));f.font.set(PDFName.of('LastChar'),ctx.obj(66));
 const widths=Array(35).fill(600);widths[0]=300;f.font.set(PDFName.of('Widths'),ctx.obj(widths));
 f.font.set(PDFName.of('ToUnicode'),ctx.register(ctx.flateStream('3 beginbfchar <20> <0020> <41> <0041> <42> <0042> endbfchar')));
 return f;
}
/** Original raw Type1C: A is a 100 by 100 triangle, FontMatrix is .002. */
export function matrixCff(){
 const idx=(items:number[][])=>{let n=1;return [0,items.length,1,...items.map(i=>{const v=n;n+=i.length;return v;}),n,...items.flat()];};
 const integer=(n:number)=>[29,0,0,0,n];
 const charStrings=idx([[14],[139,139,21,239,139,5,139,239,5,39,39,5,14]]);
 const dict=(charset:number,chars:number)=>[...integer(charset),15,...integer(chars),17,
  30,0x0a,0x00,0x2f,139,139,30,0x0a,0x00,0x2f,139,139,12,7,139,...integer(chars+charStrings.length),18];
 const name=idx([[84,105,110,121]]),start=4+name.length+idx([dict(0,0)]).length+4;
 return Uint8Array.from([1,0,4,4,...name,...idx([dict(start,start+3)]),0,0,0,0,0,0,34,...charStrings]);
}
