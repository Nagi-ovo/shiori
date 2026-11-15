import {PDFArray,PDFDict,PDFName,PDFNumber,type PDFPage} from 'pdf-lib';
import {fontInputFromDict} from '../fontCoverage/pdfLibAdapter';
import {createFontCoverage} from '../fontCoverage/coverage';
import {readProgram} from '../fontCoverage/program';
import {runToUnicode} from './runToUnicode';
import type {ResolvedRunFont} from './replaceRun';
import type {Rect} from '../contentText/regionProof';
import {simpleNames} from '../fontCoverage/encodings';
import {proveType3Glyph} from '../fontCoverage/type3Proof';
import {validRect} from '../contentText/regionProof/geometry';
import {cffHulls,isCffProgram} from '../fontCoverage/cffHulls';
const box=(dict:PDFDict|undefined):Rect|undefined=>{
 const a=dict?.lookupMaybe(PDFName.of('FontBBox'),PDFArray)?.asArray().map(v=>dict.context.lookup(v)).map(v=>v instanceof PDFNumber?v.asNumber():NaN);
 if(a?.length===4&&a.every(Number.isFinite)&&a[2]!>a[0]!&&a[3]!>a[1]!){
  const b={x:a[0]!/1000,y:a[1]!/1000,w:(a[2]!-a[0]!)/1000,h:(a[3]!-a[1]!)/1000};
  if(validRect(b)&&b.w>0&&b.h>0)return b;
 }
};
/** Source addressing never enables source encoding. Prefer embedded outlines;
 * otherwise require the declared font envelope (not the selection's quad).
 * A malformed ToUnicode may fall back to the explicit simple Encoding only.
 */
export function substituteInk(page:PDFPage,fonts:readonly ResolvedRunFont[]){
 const dict=page.node.Resources()?.lookupMaybe(PDFName.of('Font'),PDFDict);
 const resolvers=new Map<string,(code:number)=>Rect|undefined>();
 for(const font of fonts){
  const raw=dict?.lookupMaybe(PDFName.of(font.resourceName),PDFDict);if(!raw)continue;
  const input=fontInputFromDict(raw),child=raw.lookupMaybe(PDFName.of('DescendantFonts'),PDFArray)?.lookup(0,PDFDict);
  const descriptor=(child??raw).lookupMaybe(PDFName.of('FontDescriptor'),PDFDict);
  const declared=box(raw)??box(descriptor),matrix=input.subtype==='Type3'?input.fontMatrix:undefined;
  let envelope=declared&&matrix?{x:declared.x*1000*matrix[0]!,y:declared.y*1000*matrix[3]!,w:declared.w*1000*matrix[0]!,h:declared.h*1000*matrix[3]!}:declared;
  if(envelope&&(!validRect(envelope)||envelope.w<=0||envelope.h<=0))envelope=undefined;
  let program:ReturnType<typeof readProgram>|undefined;
  try{program=readProgram(input);}catch{/* Width-only addressing does not require a reusable program. */}
  // As with reflow ink, CFF top/FD transforms invalidate a /1000 fallback,
  // including when FontFile3 decoding fails before the program is available.
  if(descriptor?.has(PDFName.of('FontFile3'))||input.program&&isCffProgram(input.program)||program?.kind==='fontkit'&&program.cff)envelope=undefined;
  let hull:((gid:number)=>Rect|undefined)|undefined;
  if(program?.kind==='fontkit')try{hull=program.cff?cffHulls(input.program!):program.inkBox;}catch{/* Unproved CFF hulls stay unknown. */}
  let type1Names:ReadonlyMap<number,string>|undefined;
  if(program?.kind==='type1')try{type1Names=simpleNames(input,program.builtIn);}catch{/* An unknown glyph map leaves only the declared envelope. */}
  const coverage=createFontCoverage(input.toUnicode&&!runToUnicode(input.toUnicode,font.bytesPerCode)&&font.bytesPerCode===1&&input.encoding?{...input,toUnicode:undefined}:input);
  resolvers.set(font.resourceName,code=>{
   if(input.subtype==='Type3'){
    const proof=proveType3Glyph(input,code);if(proof.ok)return proof.proof.inkBounds??{x:0,y:0,w:0,h:0};
   }
   if(program?.kind==='fontkit'){
    const gid=coverage.glyphIds.get(code.toString(16).padStart(font.bytesPerCode*2,'0'));
    if(gid)try{const ink=hull?.(gid);if(ink&&validRect(ink))return ink;}catch{/* A failed outline leaves only a valid non-CFF envelope. */}
   }
   if(program?.kind==='type1'){
    const name=type1Names?.get(code),proof=name?program.verify(name):undefined;
    if(proof?.ok&&proof.inkBounds!==undefined){const b=proof.inkBounds;return b?{x:b.x/1000,y:b.y/1000,w:b.w/1000,h:b.h/1000}:{x:0,y:0,w:0,h:0};}
   }
   // Advances, em metrics and Unicode labels do not bound painted ink.
   // Unresolved composites retain the full declared envelope or stay unknown.
   return envelope;
  });
 }
 return (name:string,code:number)=>resolvers.get(name)?.(code);
}
/** Keep a raster guard around proved outlines and declared envelopes.
 * Zero-area declarations are rejected above; empty outlines alone skip it. */
export const inkCovered=(ink:Rect,covers:readonly Rect[],guard=.5)=>ink.w===0&&ink.h===0||covers.some(r=>
 ink.x-guard>=r.x-1e-7&&ink.x+ink.w+guard<=r.x+r.w+1e-7&&ink.y-guard>=r.y-1e-7&&ink.y+ink.h+guard<=r.y+r.h+1e-7);
