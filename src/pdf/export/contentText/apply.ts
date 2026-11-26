import {PDFName,type PDFPage} from 'pdf-lib';
import type {Overlay,ContentTextOverlay,PdfRect} from '../../model/types';
import {inspectRunPage,resolveRunFonts,runPageEnvironment} from '../contentStreamEdit/replaceRunPage';
import {compileRunPageWithFallback,replaceRunPageWithFallback,type RunPageOptions} from '../contentStreamEdit/fallbackPage';
import {tokenizeContentStream,type ContentOp} from '../contentStreamEdit/tokenizer';
import {textObjectScopes} from '../contentStreamEdit/textSafety';
import {walkTextPlacements} from '../contentStreamEdit/textState';
import {quadIntersectsRect} from '../contentStreamEdit/removeGlyphs';
import {codes,encodeRun} from '../contentStreamEdit/runEncoding';
import {applyRetypesets} from './retypeset';
import {compileLocalCorrection} from './localCorrection';
import type { ContactRenderer } from './contentTextRaster';
import {compileFittedCorrection} from './fittedCorrection';
import {deferRetypesetSiblings} from './retypesetSiblings';
import {planContentText} from './planner';
import {compilerReason,type ContentTextOutcome} from './outcomes';
import {planOriginalSlotSpacing} from './spacingPlan';
import {explainStreamReflow,type StreamReflowGate} from './reflowAuto';
import {reflowAffectedBoxes,reflowManifest} from './reflowManifest';
import {lastEditedOp,recipeWindows} from './reflowBatch';
import type {ReflowRequest} from './reflowTypes';
import {reflowEnabled} from './reflowTypes';
import type {PageRunPlan} from '../contentStreamEdit/pageRunPlan';
import {applyFontSubstitutions,type SubstituteOptions} from '../contentStreamEdit/substitute';
import { withCachedLocalFonts } from '../fonts/fontService';
import {annotationAnchorRefusal,readSourceAnnotationAnchors,type AnchoredAnnotation} from '../sourceAnnotationAnchors';
const overlaps=(a:PdfRect,b:PdfRect)=>a.x<b.x+b.w && b.x<a.x+a.w && a.y<b.y+b.h && b.y<a.y+a.h;
/** All addresses and validation are from one immutable revision. The only
 * installation is the final combined plan, after per-overlay preflight. */
export async function applyContentTextEdits(page:PDFPage,overlays:readonly Overlay[],options:RunPageOptions&SubstituteOptions&{stage5Reflow?:boolean;renderContentText?:ContactRenderer;reflowRequests?:ReadonlyMap<string,ReflowRequest>}={},sourceAnchors?:readonly AnchoredAnnotation[]){
 options=withCachedLocalFonts(options);
 const stage5Reflow=reflowEnabled(options.stage5Reflow);
 const edits=overlays.filter((o):o is ContentTextOverlay=>o.type==='contentText'),accepted=new Set<string>();
 const outcomes=new Map<string,ContentTextOutcome>(),plans=new Map<string,PageRunPlan>(),changesAdvance=new Set<string>(),terminal=new Set<string>();
 if(!edits.length)return{outcomes:[],remaining:[...overlays]};
 const anchors=sourceAnchors??readSourceAnnotationAnchors(page);
 const source=inspectRunPage(page);
 if(!source.ok)return{outcomes:edits.map(o=>({overlayId:o.id,mode:'unsupported' as const,reason:'unsupported-unwritable' as const,detail:source.reason})),remaining:[...overlays]};
 let ops:ContentOp[];
 try{ops=tokenizeContentStream(source.bytes);}catch(error){return{outcomes:edits.map(o=>({overlayId:o.id,mode:'unsupported' as const,reason:'unsupported-unwritable' as const,detail:String(error)})),remaining:[...overlays]};}
 const fonts=resolveRunFonts(page,options.stage5Type1),environment=runPageEnvironment(page),scopes=textObjectScopes(ops);
 // Keep the same all-or-nothing compilation boundary for local edits that
 // share a page. If an edit still needs paragraph fallback, that fallback
 // sees the immutable source and can preserve the other edits' ownership.
 if(edits.some(e=>e.sourceGlyphs?.length||e.sourceBaselinesPt?.length)){
  let bytes=source.bytes;
  const local=new Map<string,ContentTextOutcome>();
  let currentOps=ops;
  for(const e of edits){
   if(options.reflowRequests?.has(e.id))continue;
   const otherCovers=edits.filter(o=>o!==e).flatMap(o=>o.coverRects);
   if(e.coverRects.some(a=>otherCovers.some(b=>overlaps(a,b))))continue;
   const compiled=compileLocalCorrection(page,bytes,currentOps,fonts,e,environment,otherCovers)??
    await compileFittedCorrection(page,bytes,currentOps,fonts,e,environment,otherCovers,options.renderContentText);
   if(!compiled)continue;
   local.set(e.id, compiled.outcome);
   if(compiled.bytes){bytes=compiled.bytes;currentOps=tokenizeContentStream(bytes);}
  }
  if(local.size===edits.length){
   const only=edits[0]!, blocked=local.get(only.id);
   if(edits.length===1 && blocked?.reason==='unsupported-artwork-contact'){
    const outcomes=new Map([[only.id,blocked]]);
    const accepted=new Set<string>();
    await applyRetypesets(page,edits,outcomes,accepted,options,true,anchors);
    if(accepted.has(only.id))return{outcomes:[outcomes.get(only.id)!],remaining:overlays.filter(o=>o!==only)};
    const outcome=outcomes.get(only.id);
    if(outcome?.reason==='annotation-anchor')return{outcomes:[outcome],remaining:[...overlays]};
   }
   if(bytes!==source.bytes)page.node.set(PDFName.of('Contents'),page.doc.context.register(page.doc.context.flateStream(bytes)));
   return{outcomes:edits.map(e=>local.get(e.id)!),remaining:overlays.filter(o=>local.get(o.id)?.mode!=='in-place')};
  }
  for(const [id,outcome] of local)if(outcome.mode==='unsupported'){outcomes.set(id,outcome);terminal.add(id);}
 }
 const objectScopes=new Map<string,Set<number>>();
 const walk=walkTextPlacements(ops,{resolveFont:name=>{const f=fonts.find(f=>f.resourceName===name);return f?{...f,ok:true,appliesWordSpacing:f.bytesPerCode===1}:{ok:false,reason:'unsupported font'};},extGStateSetsFont:name=>environment.extGStates?.get(name)?.setsFont??null});
 for(const overlay of edits){
  if(terminal.has(overlay.id))continue;
  const touched=walk.ok?walk.glyphs.filter(g=>overlay.coverRects.some(r=>quadIntersectsRect(g.quad,r))).map(g=>scopes.get(g.opIndex)!):[];
  objectScopes.set(overlay.id,new Set(touched.length?touched:[...scopes.values()]));
  if(edits.some(other=>other!==overlay && other.coverRects.some(b=>overlay.coverRects.some(a=>overlaps(a,b))))){outcomes.set(overlay.id,{overlayId:overlay.id,mode:'unsupported',reason:'ambiguous-match'});continue;}
  // Diagnostic only: the exact-tier gate that refused this overlay, if any.
  let exactGate:StreamReflowGate|undefined,exactGateDetail:string|undefined;
  const reflowOrGate=(r:ReturnType<typeof explainStreamReflow>)=>{if(r.ok){exactGate=exactGateDetail=undefined;return r.plan;}exactGate=r.gate;exactGateDetail=r.detail;return null;};
  const gated=(o:ContentTextOutcome):ContentTextOutcome=>exactGate?{...o,exactGate,...(exactGateDetail?{exactGateDetail}:{})}:o;
  let planned=planContentText(source.bytes,fonts,overlay,{...environment,stage5Reflow,reflowRequest:options.reflowRequests?.get(overlay.id)});
  if(!planned.ok&&planned.code==='reflow-required'&&stage5Reflow&&!options.reflowRequests?.has(overlay.id)){
   const reflow=reflowOrGate(explainStreamReflow(page,source.bytes,fonts,overlay,{...environment,stage5Reflow},options.stage5Type1));
   if(reflow)planned={ok:true,plan:reflow};
  }
  if(!planned.ok){if(planned.terminal)terminal.add(overlay.id);outcomes.set(overlay.id,gated({overlayId:overlay.id,mode:'unsupported',reason:planned.code,detail:planned.reason,...(planned.unsafeOperator?{unsafeOperator:planned.unsafeOperator}:{})}));continue;}
  let result=await compileRunPageWithFallback(page,planned.plan,options);
  if(!result.ok&&result.code==='overflow'&&stage5Reflow&&!options.reflowRequests?.has(overlay.id)){
   const spacing=planOriginalSlotSpacing(page,source.bytes,fonts,planned.plan)??reflowOrGate(explainStreamReflow(page,source.bytes,fonts,overlay,{...environment,stage5Reflow},options.stage5Type1,planned.plan.fallbackFonts?.[0]));
   if(spacing){planned={ok:true,plan:spacing};result=await compileRunPageWithFallback(page,spacing,options);}
  }
  if(!result.ok){outcomes.set(overlay.id,gated({overlayId:overlay.id,mode:'unsupported',reason:compilerReason(result),detail:result.reason}));continue;}
  plans.set(overlay.id,planned.plan);objectScopes.set(overlay.id,new Set(planned.plan.edits.map(e=>scopes.get(e.opIndex)!)));
  if(result.usedFallback||planned.plan.reflow)changesAdvance.add(overlay.id);
  else for(const edit of planned.plan.edits){const font=fonts.find(f=>f.resourceName===edit.fontResource)!;const encoded=encodeRun(edit.replacement,font,edit.expected,planned.plan.allowExistingCodePermutation);
   const advance=(data:Uint8Array)=>codes(data,font.bytesPerCode).reduce((n,c)=>n+font.widthOf(c),0);
   if(!encoded.ok || advance(encoded.bytes)!==advance(edit.expected) || codes(encoded.bytes,font.bytesPerCode).filter(c=>c===32).length!==codes(edit.expected,font.bytesPerCode).filter(c=>c===32).length || encoded.bytes.length!==edit.expected.length)changesAdvance.add(overlay.id);
  }
  const mode=planned.plan.reflow?.substituted?'substituted':result.usedFallback?'fallback-font':planned.plan.reflow&&planned.plan.reflow.layout.strategy!=='spacing-only'?'reflowed':'in-place';
  // The faces the fallback compiler grouped for this plan; the final page
  // install regroups the same edits, so the names stay those it embeds.
  outcomes.set(overlay.id,{overlayId:overlay.id,fidelity:'exact',mode,...(mode==='fallback-font'&&result.fallbackFaces?.length?{faces:result.fallbackFaces}:{})});
 }
 // Operator ownership is larger than the UI selection. Reject BOTH original
 // plans when a recipe tail intersects another plan, even with disjoint covers.
 const conflicts=new Set<string>();
 for(const [id,p]of plans)for(const [other,q]of plans)if(id!==other&&recipeWindows(p).some(w=>
  q.edits.some(e=>e.opIndex<=w.last&&lastEditedOp(e)>=w.first)||recipeWindows(q).some(v=>v.first<=w.last&&w.first<=v.last))){conflicts.add(id);conflicts.add(other);}
 for(const id of conflicts){plans.delete(id);outcomes.set(id,{overlayId:id,mode:'unsupported',reason:'reflow-required',detail:'intersecting owned reflow tails'});}
 // A hybrid sibling can only run on original geometry. Downgrades propagate
 // until no changing-advance plan shares an object with an edit that may retypeset.
 const candidates=edits.filter(e=>!terminal.has(e.id));
 let changed=true;
 while(changed){changed=false;for(const id of [...plans.keys()])if(changesAdvance.has(id) && candidates.some(o=>!plans.has(o.id) && [...objectScopes.get(o.id)!].some(s=>objectScopes.get(id)!.has(s)))){
  plans.delete(id);outcomes.set(id,{overlayId:id,mode:'unsupported',reason:'shared-text-object'});changed=true;
 }}
 const deferred=deferRetypesetSiblings(page,ops,candidates,plans,outcomes,options.stage5Type1);
 if(plans.size){
  const combinedPlan=():PageRunPlan=>({sourceHash:source.sourceHash,allowExistingCodePermutation:true,...environment,
   edits:[...plans.values()].flatMap(p=>p.edits),reflows:[...plans.values()].flatMap(p=>p.reflow?[p.reflow]:[])});
  const blocked=new Map<string,NonNullable<ReturnType<typeof annotationAnchorRefusal>>>();
  if(anchors.length&&walk.ok)for(const [id,{reflow}]of plans){
   if(!reflow)continue;
   const anchor=annotationAnchorRefusal(anchors,reflowAffectedBoxes(reflow,walk.glyphs));
   if(anchor)blocked.set(id,anchor);
  }
  // Test the full recipe batch first so a compilation failure retains its
  // original reason. Recompile survivors against the same source revision.
  const preflight=blocked.size?await compileRunPageWithFallback(page,combinedPlan(),options):undefined;
  if(preflight?.ok)for(const [id,anchor]of blocked){
   plans.delete(id);terminal.add(id);
   outcomes.set(id,{overlayId:id,mode:'unsupported',...anchor});
  }
  if(plans.size){
   const result=preflight?.ok===false?preflight:await replaceRunPageWithFallback(page,combinedPlan(),options);
   if(result.ok)for(const [id,p]of plans){accepted.add(id);if(p.reflow&&walk.ok)outcomes.set(id,{...outcomes.get(id)!,reflow:reflowManifest(p.reflow,walk.glyphs,fonts)});}
   else for(const id of plans.keys())outcomes.set(id,{overlayId:id,mode:'unsupported',reason:compilerReason(result),detail:result.reason});
  }
 }
 const remaining=candidates.filter(e=>!terminal.has(e.id));
 await applyFontSubstitutions(page,remaining,outcomes,accepted,options,deferred,anchors);
 await applyRetypesets(page,remaining.filter(e=>outcomes.get(e.id)?.reason!=='annotation-anchor'),outcomes,accepted,options,false,anchors);
 return{outcomes:edits.map(o=>outcomes.get(o.id)!),remaining:overlays.filter(o=>!accepted.has(o.id))};
}
