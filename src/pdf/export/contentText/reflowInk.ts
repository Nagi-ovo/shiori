import {PDFArray,PDFDict,PDFName,type PDFPage} from 'pdf-lib';
import type {ResolvedRunFont} from '../contentStreamEdit/replaceRun';
import {sourceFingerprint} from '../contentStreamEdit/replaceRun';
import {fontCoverageFromDict,fontInputFromDict} from '../fontCoverage/pdfLibAdapter';
import {readProgram} from '../fontCoverage/program';
import type {GlyphIdentity,Rect,TextTrace} from './regionProof';
import {linear,validRect,validTrace} from './regionProof/geometry';
import type {Type1Options} from '../fontCoverage/type1Support';
import {cffHulls,isCffProgram} from '../fontCoverage/cffHulls';
import {createFontCoverage} from '../fontCoverage/coverage';
import {runToUnicode} from '../contentStreamEdit/runToUnicode';
import {numericArray} from './reflowScene';
import {simpleNames} from '../fontCoverage/encodings';
import {proveType3Glyph} from '../fontCoverage/type3Proof';
/** A zero box alone cannot prove an empty path (notably fontkit CFF hulls). */
export type ReflowInk={box:Rect;glyph?:GlyphIdentity;conservative:boolean;provedEmpty?:boolean};
/** Outlines are preferred; a positive-area PDF FontBBox is conservative ink,
 * independent of source encoding eligibility. No selection, advance or em
 * metric can fill a missing envelope. Unproved composites stay unknown. */
export function streamInkResolver(page:PDFPage,fonts:readonly ResolvedRunFont[],options:Type1Options={},_addressOnly=false){
 void _addressOnly;
 const dict=page.node.Resources()?.lookupMaybe(PDFName.of('Font'),PDFDict);
 const byName=new Map<string,(code:number)=>ReflowInk|undefined>();

 for(const font of fonts){
  const raw=dict?.lookupMaybe(PDFName.of(font.resourceName),PDFDict);if(!raw)continue;
  const child=raw.lookupMaybe(PDFName.of('DescendantFonts'),PDFArray)?.lookup(0,PDFDict),descriptor=(child??raw).lookupMaybe(PDFName.of('FontDescriptor'),PDFDict);
  const matrix=numericArray(raw,'FontMatrix');
  if(matrix&&(matrix.length!==6||matrix.some((n,i)=>n!==[.001,0,0,.001,0,0][i])))continue;
  const declared=numericArray(raw,'FontBBox')??(descriptor?numericArray(descriptor,'FontBBox'):undefined);
  let envelope=declared?.length===4&&declared.every(Number.isFinite)&&declared[2]!>declared[0]!&&declared[3]!>declared[1]!
   ?{x:declared[0]!/1000,y:declared[1]!/1000,w:(declared[2]!-declared[0]!)/1000,h:(declared[3]!-declared[1]!)/1000}:undefined;
  const fallback=():ReflowInk|undefined=>envelope&&validRect(envelope)&&envelope.w>0&&envelope.h>0?{box:envelope,conservative:true}:undefined;
  // FontFile3 may carry CFF top/FD transforms even when its parser throws.
  // Only a proved transformed hull can replace this unknown envelope.
  if(descriptor?.has(PDFName.of('FontFile3')))envelope=undefined;
  // A declaration bounds source paint even when an unsupported dictionary
  // idiom prevents program reuse. The encoder retains its independent gate.
  byName.set(font.resourceName,fallback);
  const input=fontInputFromDict(raw);
  if(input.program&&isCffProgram(input.program))envelope=undefined;
  if(input.subtype==='Type3'){
   byName.set(font.resourceName,code=>{const p=proveType3Glyph(input,code);return p.ok?{box:p.proof.inkBounds??{x:0,y:0,w:0,h:0},conservative:false,provedEmpty:p.proof.inkBounds===null}:undefined;});
   continue;
  }
  if(input.error||!input.program)continue;
  let program:ReturnType<typeof readProgram>;
  try{program=readProgram(input);}catch{continue;}
  const coverage=input.toUnicode&&!runToUnicode(input.toUnicode,font.bytesPerCode)&&font.bytesPerCode===1&&input.encoding?
   createFontCoverage({...input,toUnicode:undefined},options):fontCoverageFromDict(raw,options),hash=sourceFingerprint(input.program);
  if(program.kind==='fontkit'){
   // Also cover CFF programs embedded outside the usual FontFile3 slot.
   // Missing GIDs and per-glyph failures must not restore a /1000 box.
   if(program.cff)envelope=undefined;
   let hull:((gid:number)=>Rect|undefined)|undefined;
   try{hull=program.cff?cffHulls(input.program):program.inkBox;}catch{continue;}if(!hull)continue;
   byName.set(font.resourceName,code=>{
    const gid=coverage.glyphIds.get(code.toString(16).padStart(font.bytesPerCode*2,'0'));if(!gid)return fallback();
    let box:Rect|undefined;try{box=hull(gid);}catch{return fallback();}if(box&&validRect(box))return {box,glyph:{kind:'gid',programHash:hash,gid},conservative:false};
    return fallback();
   });
  }else if(program.kind==='type1'){
   const m=program.fontMatrix;
   if(m.length!==6||m.some((n,i)=>n!==[.001,0,0,.001,0,0][i])){byName.delete(font.resourceName);continue;}
   let names:ReadonlyMap<number,string>;try{names=simpleNames(input,program.builtIn);}catch{continue;}
   byName.set(font.resourceName,code=>{
    const name=names.get(code);if(!name)return;
    const proof=program.verify(name);if(!proof.ok||proof.inkBounds===undefined)return;
    const hull=proof.inkBounds;
    const box=hull===null?{x:0,y:0,w:0,h:0}:{x:hull.x/1000,y:hull.y/1000,w:hull.w/1000,h:hull.h/1000};
    return {box,glyph:{kind:'type1-name',programHash:hash,name},conservative:false,provedEmpty:hull===null};
   });
  }
 }
 return (name:string,code:number,state:TextTrace):ReflowInk|undefined=>{
  if(!validTrace(state))return;
  const ink=byName.get(name)?.(code);if(!ink)return;
  const [a,,,d]=linear(state),sx=a!*state.size*state.tz/100,sy=d!*state.size;
  return {...ink,box:{x:ink.box.x*sx,y:ink.box.y*sy,w:ink.box.w*sx,h:ink.box.h*sy}};
 };
}
