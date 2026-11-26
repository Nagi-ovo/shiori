import {PDFArray,PDFDict,PDFName,PDFNumber,PDFStream,type PDFPage} from 'pdf-lib';
import type {ContentFontInfo} from '../contentStreamEdit/glyphWidths';
import {contentFontInfo} from '../contentStreamEdit/glyphWidths';
import {fontCoverageFromDict,fontInputFromDict,streamBytes} from '../fontCoverage/pdfLibAdapter';
import {readProgram} from '../fontCoverage/program';
import {cffHulls} from '../fontCoverage/cffHulls';
import {parseCMap} from '../fontCoverage/cmap';
import {verticalWritingReason} from '../contentStreamEdit/verticalWriting';
import type {PdfRect} from '../../model/types';

export type VerticalMetric={advance:number;vx:number;vy:number};
export type VerticalFont=ContentFontInfo&{
 resourceName:string;raw:PDFDict;vertical:(code:number)=>VerticalMetric;
 labels:ReadonlyMap<string,string>;encode:(text:string)=>Uint8Array|undefined;
 ink:(code:number)=>PdfRect|undefined;
};
const fail=(detail:string):never=>{throw Error(`vertical-writing-${detail}`);};
const integer=(value:unknown)=>{
 if(!(value instanceof PDFNumber)||!Number.isInteger(value.asNumber())||Math.abs(value.asNumber())>32767)fail('metrics: expected signed 16-bit integer');
 return (value as PDFNumber).asNumber();
};
/** Require integer metrics and non-overlapping W2 rows for placement proof.
 * Defaults follow DW2. */
export function verticalMetrics(child:PDFDict,width:(cid:number)=>number){
 let vy=880,advance=-1000;
 const defaults=child.lookup(PDFName.of('DW2'));
 if(defaults!==undefined){if(!(defaults instanceof PDFArray)||defaults.size()!==2)fail('metrics: malformed DW2');vy=integer((defaults as PDFArray).lookup(0));advance=integer((defaults as PDFArray).lookup(1));}
 const values=new Map<number,VerticalMetric>(),w2=child.lookup(PDFName.of('W2'));
 const cid=(v:unknown)=>{if(!(v instanceof PDFNumber)||!Number.isInteger(v.asNumber())||v.asNumber()<0||v.asNumber()>65535)fail('metrics: invalid CID');return (v as PDFNumber).asNumber();};
 const put=(c:number,m:VerticalMetric)=>{if(c>65535||values.has(c)||m.advance>=0)fail('metrics: overlapping or non-descending W2');values.set(c,m);};
 if(w2!==undefined){
  if(!(w2 instanceof PDFArray))fail('metrics: malformed W2');
  const rows=w2 as PDFArray;
  for(let i=0;i<rows.size();){
   const first=cid(rows.lookup(i++)),second=rows.lookup(i++);
   if(second instanceof PDFArray){
    if(!second.size()||second.size()%3)fail('metrics: incomplete W2 triple');
    for(let j=0;j<second.size();j+=3)put(first+j/3,{advance:integer(second.lookup(j)),vx:integer(second.lookup(j+1)),vy:integer(second.lookup(j+2))});
   }else{
    const last=cid(second);if(last<first||last>65535||i+3>rows.size())fail('metrics: malformed W2 range');
    const m={advance:integer(rows.lookup(i++)),vx:integer(rows.lookup(i++)),vy:integer(rows.lookup(i++))};
    for(let c=first;c<=last;c++)put(c,m);
   }
  }
 }
 if(advance>=0)fail('metrics: non-descending DW2');
 return(c:number)=>values.get(c)??{advance,vx:width(c)/2,vy};
}

/** Encoding maps codes to CIDs; ToUnicode supplies labels only. Named maps
 * without a local CID proof and simple-font WMode 1 remain explicit refusals. */
export function readVerticalFont(raw:PDFDict,resourceName:string):VerticalFont{
 if(raw.lookup(PDFName.of('Subtype'))!==PDFName.of('Type0'))fail('font: simple-font WMode 1 has no CID vertical metrics proof');
 const children=raw.lookup(PDFName.of('DescendantFonts'));
 if(!(children instanceof PDFArray)||children.size()!==1)fail('metrics: malformed DescendantFonts');
 const child=(children as PDFArray).lookup(0,PDFDict),enc=raw.lookup(PDFName.of('Encoding'));
 let cidOf=(code:number):number|undefined=>code;
 if(enc!==PDFName.of('Identity-V')){
  if(!(enc instanceof PDFStream))fail('cmap: named vertical CMap has no local code-to-CID proof');
  const map=enc as PDFStream;
  if(map.dict.has(PDFName.of('UseCMap')))fail('cmap: dictionary UseCMap is unproved');
  const parsed=parseCMap(new TextDecoder('latin1').decode(streamBytes(map)));
  if(!parsed.vertical||!(parsed.identity&&!parsed.codeSpaces.length||parsed.codeSpaces.length===1&&parsed.codeSpaces[0]!.low.length===4&&parsed.codeSpaces[0]!.high.length===4))fail('cmap: requires one fixed two-byte vertical codespace');
  cidOf=code=>parsed.cids.get(code.toString(16).padStart(4,'0'))??(parsed.identity?code:undefined);
 }
 const shadow=raw.clone(),shadowChild=child.clone();
 shadow.delete(PDFName.of('WMode'));shadowChild.delete(PDFName.of('WMode'));
 shadow.set(PDFName.of('Encoding'),PDFName.of('Identity-H'));shadow.set(PDFName.of('DescendantFonts'),raw.context.obj([shadowChild]));
 const horizontal=contentFontInfo(shadow);if(!horizontal.ok)fail(`metrics: ${horizontal.reason}`);
 const h=horizontal as ContentFontInfo,metrics=verticalMetrics(child,h.widthOf),coverage=fontCoverageFromDict(raw),input=fontInputFromDict(raw);
 let hull:((gid:number)=>PdfRect|undefined)|undefined;
 try{const p=readProgram(input);if(p.kind==='fontkit')hull=p.cff?cffHulls(input.program!):p.inkBox;}catch{ /* Placement remains possible; output still requires proved ink. */ }
 return {...h,resourceName,raw,widthOf:code=>{const cid=cidOf(code);return cid===undefined?NaN:h.widthOf(cid);},
  vertical:code=>{const cid=cidOf(code);if(cid===undefined)fail('cmap: unmapped code');const m=metrics(cid!);if(![m.advance,m.vx,m.vy].every(n=>Number.isInteger(n)&&n>=-32768&&n<=32767))fail('metrics: fractional or out-of-range origin is unproved');return m;},labels:coverage.codeToUnicode,
  encode:text=>{const result=coverage.canEncode(text);return result.ok?result.bytes:undefined;},
  ink:code=>{const gid=coverage.glyphIds.get(code.toString(16).padStart(4,'0'));try{return gid?hull?.(gid):undefined;}catch{return;}}
 };
}
export function verticalPageFonts(page:PDFPage){
 const fonts=new Map<string,VerticalFont>(),failures=new Map<string,string>(),dict=page.node.Resources()?.lookupMaybe(PDFName.of('Font'),PDFDict);
 for(const [name,ref]of dict?.entries()??[]){const raw=dict!.context.lookup(ref);if(!(raw instanceof PDFDict)||!verticalWritingReason(raw))continue;
  try{fonts.set(name.decodeText(),readVerticalFont(raw,name.decodeText()));}catch(error){failures.set(name.decodeText(),String(error));}
 }
 return {fonts,failures};
}
