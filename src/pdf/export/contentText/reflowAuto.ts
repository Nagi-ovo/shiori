import type {PDFPage} from 'pdf-lib';
import type {ContentTextOverlay} from '../../model/types';
import type {PageRunPlan} from '../contentStreamEdit/pageRunPlan';
import {runContextSafety,type ResolvedRunFont} from '../contentStreamEdit/replaceRun';
import {removalsByRect} from '../contentStreamEdit/removeGlyphs';
import {encodeRun} from '../contentStreamEdit/runEncoding';
import type {Type1Options} from '../fontCoverage/type1Support';
import {streamReflowEvidence,proveDownwardSlot} from './reflowEvidence';
import {solveMeasuredReflow,legalMeasuredBreak} from './reflowLayout';
import type {ReflowCodeCluster,ContentTextEnvironment} from './reflowTypes';
import {linear} from './regionProof/geometry';
import {ReflowTraceError} from './reflowTrace';
import {RunCompileError} from '../contentStreamEdit/runRefusal';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {walkTextPlacements} from '../contentStreamEdit/textState';
const normalize=(s:string)=>s.replace(/\r\n?/g,'\n');
/** Boolean/default-on producer. Source lines, widths, ownership and first-show
 * origins are read back from the immutable stream. UI newlines grant no scene
 * or soft-break authority. User replacement breaks remain hard. */
export function planStreamReflow(page:PDFPage,content:Uint8Array,fonts:readonly ResolvedRunFont[],overlay:ContentTextOverlay,
 environment:ContentTextEnvironment={},options:Type1Options={},replacementFont?:ResolvedRunFont):PageRunPlan|null{
 if(environment.stage5Reflow===false||!overlay.sourceStyle||overlay.angle||overlay.align!=='left'||
  Object.entries(overlay.sourceStyle).some(([key,value])=>overlay[key as keyof ContentTextOverlay]!==value))return null;
 return build(page,content,fonts,overlay,environment,options,replacementFont);
}
function build(page:PDFPage,content:Uint8Array,fonts:readonly ResolvedRunFont[],overlay:ContentTextOverlay,environment:ContentTextEnvironment,options:Type1Options,replacementFont?:ResolvedRunFont):PageRunPlan|null{
 try{
  const ops=tokenizeContentStream(content),safety=runContextSafety(ops,environment);if(!safety.ok)return null;
  const walk=walkTextPlacements(ops,{resolveFont:name=>{const f=fonts.find(f=>f.resourceName===name);return f?{...f,ok:true,appliesWordSpacing:f.bytesPerCode===1}:{ok:false,reason:'unmeasurable source font'};},extGStateSetsFont:name=>environment.extGStates?.get(name)?.setsFont??null});
  if(!walk.ok)return null;
  const selected=[...new Set(removalsByRect(walk.glyphs,overlay.coverRects).flatMap(h=>[...h]))];
  if(!selected.length||selected.some(g=>safety.unsafe.has(g.opIndex)))return null;
  const e=streamReflowEvidence(page,content,fonts,selected[0]!.opIndex,options,replacementFont!==undefined);if(!e)return null;
  return planProvedStreamReflow(e,fonts,overlay,environment,replacementFont);
 }catch(error){
  if(error instanceof ReflowTraceError||error instanceof RunCompileError||error instanceof Error&&!(error instanceof TypeError||error instanceof ReferenceError))return null;
  throw error;
 }
}
/** Layout/compile boundary for an already proved immutable stream region.
 * Evidence production remains separate; this function never widens slots. */
export function planProvedStreamReflow(e:NonNullable<ReturnType<typeof streamReflowEvidence>>,fonts:readonly ResolvedRunFont[],overlay:ContentTextOverlay,
 environment:ContentTextEnvironment={},replacementFont?:ResolvedRunFont):PageRunPlan|null{
 const selected=[...new Set(removalsByRect(e.walk.glyphs,overlay.coverRects).flatMap(h=>[...h]))];
 if(!selected.length)return null;
 try{
  // coreQuad bounds the glyph width; its following gap also contains Tc/Tw.
  // Carry those measured parameters in the advance for layout/compilation,
  // retaining only the remaining source displacement as an inter-glyph gap.
  const source=e.source.map(t=>{
   const state=e.trace.shows.get(`${t.source!.opIndex}:${t.source!.itemIndex}`)!.before;
   const f=fonts.find(f=>f.resourceName===t.fontResource&&f.objectId===t.fontObject)!;
   const code=f.bytesPerCode===1?t.code[0]!:t.code[0]!*256+t.code[1]!;
   const advance=(f.widthOf(code)*state.size/1000+state.tc+(f.bytesPerCode===1&&code===32?state.tw:0))*linear(state)[0]!*state.tz/100;
   return {...t,advance,gap:t.gap+t.advance-advance,metrics:{size:state.size,tc:state.tc,tw:state.tw}};
  });
  const indices=source.flatMap((t,i)=>selected.some(g=>g.opIndex===t.source!.opIndex&&g.arrayItemIndex===t.source!.itemIndex&&g.byteOffset===t.source!.byteStart)?[i]:[]);
  if(indices.length!==selected.length||indices.some((v,i)=>i>0&&v!==indices[i-1]!+1))return null;
  const start=indices[0]!,end=indices.at(-1)!+1,old=source.slice(start,end),first=old[0]!;
  const original=normalize(overlay.originalText),replacementText=normalize(overlay.text);
  const sourceLines:string[]=[];
  for(const t of old){const row=t.original!.line-old[0]!.original!.line;sourceLines[row]=(sourceLines[row]??'')+t.unicode;}
  // Exact whitespace too: an inferred PDFium space cannot become a byte span.
  if(original!==sourceLines.join('\n')&&!(original.indexOf('\n')<0&&original===sourceLines.join('')))return null;
  const state=e.trace.shows.get(`${first.source!.opIndex}:${first.source!.itemIndex}`)!.before;
  const sourceFont=fonts.find(f=>f.resourceName===first.fontResource)!;
  // Prepared resources must already be measurable at this page boundary.
  // Installing a new substitute resource remains the substitution caller's
  // transaction; absent dictionaries/ink never grant reflow authority.
  const font=replacementFont?fonts.find(f=>f.resourceName===replacementFont.resourceName&&f.objectId===replacementFont.objectId):sourceFont;
  if(!font||old.some(t=>t.fontObject!==sourceFont.objectId)||Math.abs(overlay.fontSize-first.em)>.05)return null;
  const substituted=font.objectId!==sourceFont.objectId;
  const replacement:ReflowCodeCluster[]=[];
  for(const {segment}of new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(replacementText)){
   if(segment==='\n'){
    if(!replacement.length||replacement.at(-1)!.hardAfter)return null;
    replacement.at(-1)!.hardAfter=true;continue;
   }
   const encoded=encodeRun(segment,font,substituted?new Uint8Array():Uint8Array.from(old.flatMap(t=>[...t.code])));
   if(!encoded.ok||encoded.codes.length!==1)return null;
   const code=font.bytesPerCode===1?encoded.bytes[0]!:encoded.bytes[0]!*256+encoded.bytes[1]!;
   const measured=e.ink(font.resourceName,code,state);if(!measured)return null;
   const scale=linear(state)[0]!*state.tz/100;
   const advance=(font.widthOf(code)*state.size/1000+state.tc+(font.bytesPerCode===1&&code===32?state.tw:0))*scale;
   replacement.push({...first,fontResource:font.resourceName,fontObject:font.objectId,unicode:segment,advance,ink:measured.box,code:encoded.bytes,source:undefined,original:undefined,glyph:measured.glyph,
    wordSpace:font.bytesPerCode===1&&code===32,fullEmHan:font.widthOf(code)===1000,gap:0,hardAfter:false});
  }
  if(!replacement.length||replacement.at(-1)!.hardAfter)return null;
  const softBreaks:number[]=[];
  for(let i=0;i<source.length-1;i++){
   const a=source[i]!,b=source[i+1]!;
   // The stream itself must show a complete regular visual line AND a legal
   // code boundary. Latin with missing source whitespace stays hard.
   if(a.original!.line!==b.original!.line&&legalMeasuredBreak(a,b))softBreaks.push(a.original!.line);
  }
  let proof=e.proof,layout=solveMeasuredReflow({source,replacement,start,end,proof,softBreaks});
  while(!layout.ok&&layout.code==='overflow'){
   const grown=proveDownwardSlot(e,proof);if(!grown)break;
   proof=grown;layout=solveMeasuredReflow({source,replacement,start,end,proof,softBreaks});
  }
  if(!layout.ok||layout.strategy==='fixed')return null;
  // A preceding fixed tactic may not use speculative growth; only wrap may.
  if(layout.strategy!=='wrap'&&proof!==e.proof)return null;
  const firstOp=proof.owned[0]!.opIndex,lastOp=proof.owned.at(-1)!.opIndex;
  const edits:PageRunPlan['edits'][number][]=[];
  for(const address of proof.owned.filter(s=>s.opIndex>=firstOp)){
   const op=e.ops[address.opIndex]!,item=op.operator==='TJ'&&op.operands[0]?.kind==='array'?op.operands[0].items[address.itemIndex]:op.operands[0];
   const f=fonts.find(f=>f.objectId===address.fontObject);if(!f||item?.kind!=='string')return null;
   edits.push({fontResource:f.resourceName,fontObject:f.objectId,opIndex:address.opIndex,itemIndex:address.itemIndex,
    byteStart:0,byteEnd:item.bytes.length,expected:item.bytes.slice(),replacement:''});
  }
  const rejoin=e.trace.ends.get(lastOp)!;
  const saved=e.trace.shows.get(`${firstOp}:${proof.owned[0]!.itemIndex}`)!.before;
  const clusters=[...source.slice(0,start),...replacement,...source.slice(end)];
  return {sourceHash:proof.sourceHash,allowExistingCodePermutation:true,...environment,edits,
   reflow:{...(substituted?{substituted:true}:{}),proof,saved,layout,clusters,firstOp,lastOp,rejoin}};
 }catch(error){
  if(error instanceof ReflowTraceError||error instanceof RunCompileError||error instanceof Error&&!(error instanceof TypeError||error instanceof ReferenceError))return null;
  throw error;
 }
}
