import {type1Fixture} from './type1Wiring.test-support';
import {widthChar,nums} from '../fontCoverage/fixtures/type1';
import {PDFDict,PDFName,PDFObjectCopier} from 'pdf-lib';
export const regionRows=['S i i i i ','S i i i i ','S i'];
export const regionStream=(tagged=false,bridge='')=>regionRows.map((s,i)=>`${tagged?`q /P <</MCID ${i}>> BDC /Span BMC `:''}BT /F1 10 Tf 0 Tc 0 Tw 100 Tz 0 Ts 14 TL 50 ${150-i*14} Td (${s}) Tj ET${tagged?' EMC EMC Q':''}${i===0?bridge:''}`).join(' ');
export async function type1RegionPage(stream=['AB AB AB ','AB AB AB ','AB '].map((s,i)=>`BT /F1 10 Tf 14 TL 50 ${150-i*14} Td (${s}) Tj ET`).join(' '),slant=0){
 const rect=Uint8Array.from([...nums(0,600),13,...nums(0,0),21,...nums(300,0),5,...nums(slant,700),5,...nums(-300,0),5,9,14]);
 const f=await type1Fixture({stream,programOptions:{glyphs:{'.notdef':widthChar(0),A:rect,B:rect,space:widthChar(300)}}});
 const ctx=f.doc.context;f.font.set(PDFName.of('FirstChar'),ctx.obj(32));f.font.set(PDFName.of('LastChar'),ctx.obj(66));
 const widths=Array(35).fill(600);widths[0]=300;f.font.set(PDFName.of('Widths'),ctx.obj(widths));
 f.font.set(PDFName.of('ToUnicode'),ctx.register(ctx.flateStream('3 beginbfchar <20> <0020> <41> <0041> <42> <0042> endbfchar')));
 return f;
}
/** Distinct embedded roman/italic programs; the second row can be justified
 * with different Tc/Tw while keeping the same measured right margin. */
export async function mixedRegionPage(options:{sameBt?:boolean;spacing?:boolean;bridge?:string;indent?:number;short?:boolean;fragments?:boolean;full?:boolean;tail?:string;spaceInRoman?:boolean}={}){
 const {sameBt=false,spacing=false,bridge='',indent=0,short=false,fragments=false,full=false,tail='',spaceInRoman=false}=options;
 const first=indent>0?'AB AB ':indent<0?'AB AB AB AB ':'AB AB AB ';
 const italic=spaceInRoman?'(B) Tj /F1 10 Tf ( AB AB ) Tj':'(B ) Tj /F1 10 Tf (AB AB ) Tj';
 const rows=[`(${first}) Tj`,`${fragments?'(A) Tj ET BT /F2 10 Tf 14 TL 56 136 Td':'(A) Tj /F2 10 Tf'} ${italic}`,`(${full?'AB AB AB ':'AB '}) Tj`].slice(0,short?2:3);
 const stream=rows.map((row,i)=>`${sameBt&&i>0?'0 -14 Td':`BT /F1 10 Tf 14 TL ${50+(i===0?indent:0)} ${150-i*14} Td`} ${spacing&&i===1?'.1 Tc -.3 Tw':'0 Tc 0 Tw'} ${row}${sameBt&&i<rows.length-1?'':' ET'}${i===0?bridge:''}`).join(' ')+tail;
 const f=await type1RegionPage(stream),italicFont=await type1RegionPage('',100);
 const copier=PDFObjectCopier.for(italicFont.doc.context,f.doc.context);
 f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).set(PDFName.of('F2'),copier.copy(italicFont.ref));
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
