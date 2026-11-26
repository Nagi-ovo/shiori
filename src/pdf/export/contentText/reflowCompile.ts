import {replaceRuns,sourceFingerprint,type ResolvedRunFont,type RunResult} from '../contentStreamEdit/replaceRun';
import type {PageRunPlan} from '../contentStreamEdit/pageRunPlan';
import {codes} from '../contentStreamEdit/runEncoding';
import {ContentStreamParseError,tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {walkTextPlacements,type UnplacedShow} from '../contentStreamEdit/textState';
import {RunCompileError} from '../contentStreamEdit/runRefusal';
import {traceReflowSource,ReflowTraceError} from './reflowTrace';
import {emitReflowSlot,restoreReflowSlot,homeOp} from './reflowEmit';
import {expectedMarkedCodes,markedCodesMatch} from './reflowMarkedContent';

/** Additive R8 compiler. Existing fixed edits keep replaceRuns. A reflow
 * recipe first uses that compiler for source/font/state verification only,
 * then emits positioned shows inside its owned operator window and restores
 * BOTH Tlm and Tm. Nothing installs bytes before the final independent walk.
 */
export function compileReflowPlan(content:Uint8Array,fonts:readonly ResolvedRunFont[],plan:PageRunPlan):RunResult {
 const refuse=(reason:string,code:'unsupported-state'|'stale-source'|'font-coverage'='unsupported-state'):RunResult=>({ok:false,code,reason,bytes:content});
 if(!plan.reflow)return replaceRuns(content,fonts,plan);
 try{
  if(sourceFingerprint(content)!==plan.sourceHash)return refuse('stale source fingerprint','stale-source');
  const {reflow:recipe,...fixed}=plan;
  const verified=replaceRuns(content,fonts,fixed);if(!verified.ok)return verified;
  const ops=tokenizeContentStream(content),{firstOp,lastOp,rejoin,clusters,layout,proof}=recipe;
  if(!ops[firstOp]||!ops[lastOp]||firstOp>lastOp||clusters.length!==layout.origins.length)
   return refuse('reflow-context-unsupported: invalid owned window');
  const trace=traceReflowSource(ops,fonts,proof.scopeProofHash,plan);
  const current=trace.ends.get(lastOp);
  if(!current||current.fontObject!==rejoin.fontObject||current.tm.some((n,i)=>Math.abs(n-rejoin.tm[i]!)>1e-7)||
   current.tlm.some((n,i)=>Math.abs(n-rejoin.tlm[i]!)>1e-7))return refuse('reflow-context-unsupported: stale rejoin trace');
  const ownedOps=new Set(proof.owned.filter(s=>s.opIndex>=firstOp&&s.opIndex<=lastOp).map(s=>s.opIndex));
  if(clusters.some(t=>!(t.source&&t.source.opIndex<firstOp)&&!ownedOps.has(homeOp(t)!)))
   return refuse('reflow-context-unsupported: output has no owned home slot');
  const body:string[]=[],literal=(start:number,end:number)=>Array.from(content.subarray(start,end),b=>String.fromCharCode(b)).join('');
  // Emit each home op under its original BDC and graphics state. Non-show
  // operators are replayed literally; even emptied slots restore locally.
  for(let i=firstOp;i<=lastOp;i++){
   const op=ops[i]!;
   if(ownedOps.has(i)){
    const address=proof.owned.find(s=>s.opIndex===i)!,local=trace.shows.get(`${i}:${address.itemIndex}`)?.before,end=trace.ends.get(i);
    if(!local||!end||!['Tj','TJ'].includes(op.operator))return refuse('reflow-context-unsupported: missing home show');
    const slot=clusters.flatMap((t,n)=>homeOp(t)===i?[{t,p:layout.origins[n]!}]:[]);
    // Replaying an untouched source show preserves even an isolated space's
    // native extraction and paint slot. Changed/moved slots still use the
    // strict emitter; the final independent walk verifies every retained code.
    if(slot.length&&slot.every(({t,p})=>t.source?.opIndex===i&&t.fontObject===t.source.fontObject&&
     t.original&&p[0]===t.original.x&&p[1]===t.original.y)){
     body.push(literal(op.start,op.end));continue;
    }
    body.push(...emitReflowSlot(recipe,fonts,i,local),restoreReflowSlot(end,fonts));
   }else body.push(literal(op.start,op.end));
  }
  // Original operators may touch delimiters (Td(...)Tj). Keep separators
  // inside the patch so both direct and batched splices preserve token bounds.
  const patch=Uint8Array.from(` ${body.join(' ')} `,c=>c.charCodeAt(0));
  const prefix=content.subarray(0,ops[firstOp]!.start),suffix=content.subarray(ops[lastOp]!.end);
  const bytes=new Uint8Array(prefix.length+patch.length+suffix.length);
  bytes.set(prefix);bytes.set(patch,prefix.length);bytes.set(suffix,prefix.length+patch.length);
  const resolveFont=(name:string)=>{const font=fonts.find(f=>f.resourceName===name);return font?{...font,ok:true as const,appliesWordSpacing:font.bytesPerCode===1}:{ok:false as const,reason:'unmeasurable source font'};};
  const oldUnplaced:UnplacedShow[]=[],newUnplaced:UnplacedShow[]=[];
  const callbacks={resolveFont,extGStateSetsFont:(name:string)=>plan.extGStates?.get(name)?.setsFont??null};
  const before=walkTextPlacements(ops,{...callbacks,onUnplaced:s=>oldUnplaced.push(s)}),outputOps=tokenizeContentStream(bytes),after=walkTextPlacements(outputOps,{...callbacks,onUnplaced:s=>newUnplaced.push(s)});
  if(!before.ok||!after.ok)return refuse('reflow-context-unsupported: compiled walk failed');
  const unplacedState=(s:UnplacedShow)=>({font:s.fontName,origin:s.origin,size:s.fontSizePt,advanceKnown:s.advanceKnown,reason:s.reason,
   glyphs:s.glyphs?.map(g=>({font:g.fontName,code:g.code,quad:g.quad,core:g.coreQuad}))});
  if(JSON.stringify(oldUnplaced.map(unplacedState))!==JSON.stringify(newUnplaced.map(unplacedState)))return refuse('reflow-context-unsupported: unplaced text changed');
  const intended=clusters.flatMap((t,i)=>t.source&&t.source.opIndex<firstOp?[]:[{fontName:t.fontResource,code:codes(t.code,fonts.find(f=>f.resourceName===t.fontResource)!.bytesPerCode)[0]!,x:layout.origins[i]![0],y:layout.origins[i]![1]}]);
  const unchanged=(g:typeof before.glyphs[number])=>({fontName:g.fontName,code:g.code,x:g.coreQuad[0].x,y:g.coreQuad[0].y});
  const expected=[...before.glyphs.filter(g=>g.opIndex<firstOp).map(unchanged),...intended,...before.glyphs.filter(g=>g.opIndex>lastOp).map(unchanged)];
  if(after.glyphs.length!==expected.length||after.glyphs.some((g,i)=>{const e=expected[i]!;return g.fontName!==e.fontName||g.code!==e.code||Math.hypot(g.coreQuad[0].x-e.x,g.coreQuad[0].y-e.y)>.00001;}))
   return refuse('layout-metrics-disagreement: compiled glyph destinations differ');
  const expectedMarked=expectedMarkedCodes(before.glyphs,trace,recipe,fonts);
  const rewalk=traceReflowSource(outputOps,fonts,proof.scopeProofHash,plan);
  if(!markedCodesMatch(expectedMarked,after.glyphs,rewalk))return refuse('layout-metrics-disagreement: compiled MCID code sequences differ');
  const final=outputOps.findLastIndex(op=>op.end<=prefix.length+patch.length);
  const joined=rewalk.ends.get(final);
  if(!joined||joined.tm.some((n,i)=>Math.abs(n-rejoin.tm[i]!)>1e-7)||joined.tlm.some((n,i)=>Math.abs(n-rejoin.tlm[i]!)>1e-7))
   return refuse('layout-metrics-disagreement: compiled Tm/Tlm rejoin differs');
  return {ok:true,bytes};
 }catch(error){
  if(error instanceof ReflowTraceError||error instanceof ContentStreamParseError)return refuse(error.message);
  if(error instanceof RunCompileError)return {ok:false,code:error.code,reason:error.message,bytes:content};
  // Recipe compilation is speculative: failed walks or incomplete recipes
  // must retain the source and let the caller try approximate retypesetting.
  return refuse(`reflow-context-unsupported: ${error instanceof Error?error.message:'compilation failed'}`);
 }
}
