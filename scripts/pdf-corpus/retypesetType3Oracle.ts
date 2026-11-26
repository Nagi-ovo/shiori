import assert from 'node:assert/strict';
import {PDFDict,PDFName,type PDFPage} from 'pdf-lib';
import {inspectRunPage} from '../../src/pdf/export/contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../../src/pdf/export/contentStreamEdit/tokenizer';
import {readRetypesetSource} from '../../src/pdf/export/contentText/retypesetSource';
import {stackedColumnOwnership} from './retypesetOracle';
import {resourceFingerprint} from './retypesetFormWalkOracle';

type Glyph={text:string;origin:readonly number[];box:readonly number[];fontSize:number;fontHash?:string;nativePath?:unknown};
const close=(a:readonly number[],b:readonly number[])=>Math.hypot(a[0]!-b[0]!,a[1]!-b[1]!)<=.01;
/** Saved code and complete font/resource graph identity supplement native
 * ink for uniformly resized Type 3 columns. No producer size claim or glyph
 * extent alone authorizes a changed procedure, matrix, encoding or resource. */
export function assertScaledColumnType3Glyphs(before:PDFPage,after:PDFPage,source:readonly Glyph[],output:readonly Glyph[],owned:readonly {text?:string;origin:readonly number[]}[]){
 assert(stackedColumnOwnership(owned.map(g=>({...g,text:g.text??''}))),'Type 3 resize requires a source column');
 const snapshot=(page:PDFPage)=>{
  const content=inspectRunPage(page);assert(content.ok,'Type 3 source stream missing');
  const read=readRetypesetSource(page,tokenizeContentStream(content.bytes),undefined,undefined,{flippedType3:true});
  assert(read.walk.ok&&!read.walk.unplacedText,'Type 3 source walk failed');
  const fonts=page.node.Resources()?.lookupMaybe(PDFName.of('Font'),PDFDict),hashes=new Map<string,string>();
  return read.glyphs.flatMap(g=>{
   const font=fonts?.lookupMaybe(PDFName.of(g.glyph.fontName),PDFDict);
   if(font?.get(PDFName.of('Subtype'))!==PDFName.of('Type3'))return[];
   let hash=hashes.get(g.glyph.fontName);if(!hash){hash=resourceFingerprint(font);hashes.set(g.glyph.fontName,hash);}
   const s=g.state;
   return[{origin:[g.x,g.y],code:g.glyph.code,hash,size:s.fontSize,shape:JSON.stringify([s.ctm!.slice(0,4),s.textMatrix!.slice(0,4),s.horizontalScale,s.rise,s.renderMode])}];
  });
 };
 const old=snapshot(before),actual=snapshot(after);let uniform:number|undefined;
 for(const g of output){
  const placements=actual.filter(p=>close(p.origin,g.origin));assert(placements.length===1,'Type 3 output identity is ambiguous');
  const p=placements[0]!,matches=source.flatMap(o=>{
   if(o.text!==g.text||o.fontHash!==undefined||o.nativePath!==null)return[];
   return old.filter(q=>close(q.origin,o.origin)&&q.hash===p.hash&&q.code===p.code&&q.shape===p.shape).map(q=>({o,q}));
  });
  assert(matches.length,'Type 3 replacement code/font identity differs from source');
  const match=matches.find(({o,q})=>{
   const scale=p.size/q.size;
   return scale>=.85-1e-6&&scale<=1+1e-6&&Math.abs(g.fontSize/o.fontSize-scale)<=.001;
  });
  assert(match,'Type 3 replacement size leaves the bounded source scale');
  const scale=p.size/match.q.size;
  if(uniform!==undefined)assert(Math.abs(scale-uniform)<1e-6,'Type 3 column mixes size scales');uniform=scale;
  for(const [lo,hi]of [[0,2],[1,3]])assert(Math.abs((g.box[hi!]!-g.box[lo!]!)-(match.o.box[hi!]!-match.o.box[lo!]!)*scale)<=.05,'Type 3 native extent differs from uniform scale');
 }
 return output.length;
}
