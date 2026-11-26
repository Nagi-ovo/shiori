import type {PDFPage} from 'pdf-lib';
import type {ContentTextOverlay} from '../../model/types';
import type {PageRunPlan} from '../contentStreamEdit/pageRunPlan';
import {runContextSafety,type ResolvedRunFont} from '../contentStreamEdit/replaceRun';
import {removalsByRect} from '../contentStreamEdit/removeGlyphs';
import {encodeRun} from '../contentStreamEdit/runEncoding';
import type {Type1Options} from '../fontCoverage/type1Support';
import {streamReflowEvidence,proveDownwardSlot,type StreamReflowEvidence,type StreamEvidenceGate} from './reflowEvidence';
import {solveMeasuredReflow,legalMeasuredBreak} from './reflowLayout';
import type {ReflowCodeCluster,ContentTextEnvironment} from './reflowTypes';
import {linear} from './regionProof/geometry';
import {ReflowTraceError} from './reflowTrace';
import {RunCompileError} from '../contentStreamEdit/runRefusal';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {walkTextPlacements} from '../contentStreamEdit/textState';
import {proveGlyphRegion} from './regionProof/glyphRegion';
import {visualLineEnd} from './regionProof/visualGroups';
import {proveSuffixGlueScene} from './regionProof/suffixGlue';
const normalize=(s:string)=>s.replace(/\r\n?/g,'\n');
/** Diagnostic-only name of the first exact-tier gate that refused. It never
 * changes a decision; reports carry it so refusals can be binned. */
export type StreamReflowGate=StreamEvidenceGate|'disabled-or-style'|'no-selection'|'selection-unsafe'|
 'selection-not-contiguous'|'scope-change'|'source-text-mismatch'|'mixed-font-or-size'|'hard-break'|'encode-failed'|
 'replacement-ink-unproved'|'grow-down-space-not-proved'|'grow-down-still-overflow'|'row-local-overflow'|'layout-refused'|
 'growth-not-allowed-for-strategy'|'owned-item-unaddressable'|'suffix-glue-unproved'|'glyph-region-unproved'|'trace-refused';
export type StreamReflowResult={ok:true;plan:PageRunPlan}|{ok:false;gate:StreamReflowGate;detail?:string};
const no=(gate:StreamReflowGate,detail?:string):StreamReflowResult=>({ok:false,gate,detail});
const caught=(error:unknown):StreamReflowResult=>{
 if(error instanceof ReflowTraceError||error instanceof RunCompileError||error instanceof Error&&!(error instanceof TypeError||error instanceof ReferenceError))return no('trace-refused',String(error));
 throw error;
};
const plan=(r:StreamReflowResult)=>r.ok?r.plan:null;
/** Boolean/default-on producer. Source lines, widths, ownership and first-show
 * origins are read back from the immutable stream. UI newlines grant no scene
 * or soft-break authority. User replacement breaks remain hard. */
export function planStreamReflow(page:PDFPage,content:Uint8Array,fonts:readonly ResolvedRunFont[],overlay:ContentTextOverlay,
 environment:ContentTextEnvironment={},options:Type1Options={},replacementFont?:ResolvedRunFont):PageRunPlan|null{
 return plan(explainStreamReflow(page,content,fonts,overlay,environment,options,replacementFont));
}
/** Same decision as planStreamReflow, with the refusing gate named. */
export function explainStreamReflow(page:PDFPage,content:Uint8Array,fonts:readonly ResolvedRunFont[],overlay:ContentTextOverlay,
 environment:ContentTextEnvironment={},options:Type1Options={},replacementFont?:ResolvedRunFont):StreamReflowResult{
 if(environment.stage5Reflow===false||!overlay.sourceStyle||overlay.angle||overlay.align!=='left'||
  Object.entries(overlay.sourceStyle).some(([key,value])=>overlay[key as keyof ContentTextOverlay]!==value))return no('disabled-or-style');
 try{
  const ops=tokenizeContentStream(content),safety=runContextSafety(ops,environment);if(!safety.ok)return no('run-context-unsafe',safety.reason);
  const walk=walkTextPlacements(ops,{resolveFont:name=>{const f=fonts.find(f=>f.resourceName===name);return f?{...f,ok:true,appliesWordSpacing:f.bytesPerCode===1}:{ok:false,reason:'unmeasurable source font'};},extGStateSetsFont:name=>environment.extGStates?.get(name)?.setsFont??null});
  if(!walk.ok)return no('placement-walk-failed',walk.reason);
  const selected=[...new Set(removalsByRect(walk.glyphs,overlay.coverRects).flatMap(h=>[...h]))];
  if(!selected.length)return no('no-selection');
  if(selected.some(g=>safety.unsafe.has(g.opIndex)))return no('selection-unsafe');
  const e=streamReflowEvidence(page,content,fonts,selected[0]!.opIndex,options,replacementFont!==undefined);
  if(!e.ok)return no(e.gate,`${e.blocker?`${e.blocker}: `:''}${e.detail}`);
  return explainProvedStreamReflow(e,fonts,overlay,environment,replacementFont);
 }catch(error){return caught(error);}
}
/** Layout/compile boundary for an already proved immutable stream region.
 * Evidence production remains separate; this function never widens slots. */
export function planProvedStreamReflow(e:StreamReflowEvidence,fonts:readonly ResolvedRunFont[],overlay:ContentTextOverlay,
 environment:ContentTextEnvironment={},replacementFont?:ResolvedRunFont):PageRunPlan|null{
 return plan(explainProvedStreamReflow(e,fonts,overlay,environment,replacementFont));
}
export function explainProvedStreamReflow(e:StreamReflowEvidence,fonts:readonly ResolvedRunFont[],overlay:ContentTextOverlay,
 environment:ContentTextEnvironment={},replacementFont?:ResolvedRunFont):StreamReflowResult{
 const selected=[...new Set(removalsByRect(e.walk.glyphs,overlay.coverRects).flatMap(h=>[...h]))];
 if(!selected.length)return no('no-selection');
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
  if(indices.length!==selected.length||indices.some((v,i)=>i>0&&v!==indices[i-1]!+1))return no('selection-not-contiguous',`selected=${selected.length} inProof=${indices.length}`);
  const start=indices[0]!,end=indices.at(-1)!+1,old=source.slice(start,end),first=old[0]!;
  const marked=e.trace.shows.get(`${first.source!.opIndex}:${first.source!.itemIndex}`)!.before;
  if(old.some(t=>{
   const state=e.trace.shows.get(`${t.source!.opIndex}:${t.source!.itemIndex}`)!.before;
   return state.scopeKey!==marked.scopeKey||JSON.stringify(state.mcids)!==JSON.stringify(marked.mcids);
  }))return no('scope-change');
  const original=normalize(overlay.originalText),replacementText=normalize(overlay.text);
  const sourceLines:string[]=[];
  for(const t of old){const row=t.original!.line-old[0]!.original!.line;sourceLines[row]=(sourceLines[row]??'')+t.unicode;}
  // Exact whitespace too: an inferred PDFium space cannot become a byte span.
  if(original!==sourceLines.join('\n')&&!(original.indexOf('\n')<0&&original===sourceLines.join('')))return no('source-text-mismatch');
  const state=e.trace.shows.get(`${first.source!.opIndex}:${first.source!.itemIndex}`)!.before;
  const sourceFont=fonts.find(f=>f.resourceName===first.fontResource)!;
  // Prepared resources must already be measurable at this page boundary.
  // Installing a new substitute resource remains the substitution caller's
  // transaction; absent dictionaries/ink never grant reflow authority.
  const font=replacementFont?fonts.find(f=>f.resourceName===replacementFont.resourceName&&f.objectId===replacementFont.objectId):sourceFont;
  if(!font||old.some(t=>t.fontObject!==sourceFont.objectId)||Math.abs(overlay.fontSize-first.em)>.05)return no('mixed-font-or-size');
  const substituted=font.objectId!==sourceFont.objectId;
  const replacement:ReflowCodeCluster[]=[];
  for(const {segment}of new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(replacementText)){
   if(segment==='\n'){
    if(!replacement.length||replacement.at(-1)!.hardAfter)return no('hard-break');
    replacement.at(-1)!.hardAfter=true;continue;
   }
   const encoded=encodeRun(segment,font,substituted?new Uint8Array():Uint8Array.from(old.flatMap(t=>[...t.code])));
   if(!encoded.ok||encoded.codes.length!==1)return no('encode-failed',`${JSON.stringify(segment)}: ${encoded.ok?'multi-code cluster':encoded.reason}`);
   const code=font.bytesPerCode===1?encoded.bytes[0]!:encoded.bytes[0]!*256+encoded.bytes[1]!;
   const measured=e.ink(font.resourceName,code,state);if(!measured)return no('replacement-ink-unproved',JSON.stringify(segment));
   const scale=linear(state)[0]!*state.tz/100;
   const advance=(font.widthOf(code)*state.size/1000+state.tc+(font.bytesPerCode===1&&code===32?state.tw:0))*scale;
   replacement.push({...first,homeOp:first.source!.opIndex,fontResource:font.resourceName,fontObject:font.objectId,unicode:segment,advance,ink:measured.box,code:encoded.bytes,source:undefined,original:undefined,glyph:measured.glyph,
    wordSpace:font.bytesPerCode===1&&code===32,fullEmHan:font.widthOf(code)===1000,gap:0,hardAfter:false});
  }
  if(!replacement.length||replacement.at(-1)!.hardAfter)return no('hard-break');
  const softBreaks:number[]=[];
  for(let i=0;i<source.length-1;i++){
   const a=source[i]!,b=source[i+1]!;
   // The stream itself must show a complete regular visual line AND a legal
   // code boundary. Latin with missing source whitespace stays hard.
   if(a.original!.line!==b.original!.line&&legalMeasuredBreak(a,b))softBreaks.push(a.original!.line);
  }
  const ownEnd=e.lines.length===1?visualLineEnd(e.lines[0]!,e.trace.ends):undefined;
  let proof=e.proof,layout=solveMeasuredReflow({source,replacement,start,end,proof,softBreaks,ownEnd}),grew=0;
  while(!proof.rowLocal&&!layout.ok&&layout.code==='overflow'){
   const grown=proveDownwardSlot(e,proof,[...replacement,...source.slice(end)]);if(!grown)break;
   proof=grown;grew++;layout=solveMeasuredReflow({source,replacement,start,end,proof,softBreaks,ownEnd});
  }
  if(!layout.ok)return no(layout.code!=='overflow'?'layout-refused':proof.rowLocal?'row-local-overflow':grew?'grow-down-still-overflow':'grow-down-space-not-proved',
   `${layout.reason}; lines=${e.lines.length} leading=${e.proof.leadingPt} grew=${grew}`);
  // A fixed whole-selection layout can fit when the earlier byte-span edit
  // overflowed. It still needs the same destination proof and compiler checks.
  // A preceding fixed tactic may not use speculative growth; only wrap may.
  if(layout.strategy!=='wrap'&&proof!==e.proof)return no('growth-not-allowed-for-strategy',layout.strategy);
  const firstOp=proof.owned[0]!.opIndex,lastOp=proof.owned.at(-1)!.opIndex;
  const edits:PageRunPlan['edits'][number][]=[];
  for(const address of proof.owned.filter(s=>s.opIndex>=firstOp)){
   const op=e.ops[address.opIndex]!,item=op.operator==='TJ'&&op.operands[0]?.kind==='array'?op.operands[0].items[address.itemIndex]:op.operands[0];
   const f=fonts.find(f=>f.objectId===address.fontObject);if(!f||item?.kind!=='string')return no('owned-item-unaddressable');
   edits.push({fontResource:f.resourceName,fontObject:f.objectId,opIndex:address.opIndex,itemIndex:address.itemIndex,
    byteStart:0,byteEnd:item.bytes.length,expected:item.bytes.slice(),replacement:''});
  }
  const rejoin=e.trace.ends.get(lastOp)!;
  const saved=e.trace.shows.get(`${firstOp}:${proof.owned[0]!.itemIndex}`)!.before;
  const clusters=[...source.slice(0,start),...replacement,...source.slice(end)];
  if(layout.strategy==='row-justify'&&!proveSuffixGlueScene(e,proof,end,clusters,layout.origins))return no('suffix-glue-unproved');
  const region=proveGlyphRegion(e,proof,clusters,layout.origins,old,layout.strategy==='row-justify');if(!region)return no('glyph-region-unproved',layout.strategy);
  return {ok:true,plan:{sourceHash:proof.sourceHash,allowExistingCodePermutation:true,...environment,edits,
   reflow:{...(substituted?{substituted:true}:{}),proof:region,saved,layout,clusters,firstOp,lastOp,rejoin}}};
 }catch(error){return caught(error);}
}
