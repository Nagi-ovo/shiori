import type {PDFPage} from 'pdf-lib';
import type {Overlay,ContentTextOverlay,PdfRect} from '../../model/types';
import {inspectRunPage,resolveRunFonts,runPageEnvironment} from '../contentStreamEdit/replaceRunPage';
import {compileRunPageWithFallback,replaceRunPageWithFallback,type RunPageOptions} from '../contentStreamEdit/fallbackPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {textObjectScopes} from '../contentStreamEdit/textSafety';
import {walkTextPlacements} from '../contentStreamEdit/textState';
import {quadIntersectsRect} from '../contentStreamEdit/removeGlyphs';
import {codes,encodeRun} from '../contentStreamEdit/runEncoding';
import {planContentText} from './planner';
import {compilerReason,type ContentTextOutcome} from './outcomes';
import {planOriginalSlotSpacing} from './spacingPlan';
import {reflowManifest} from './reflowManifest';
import {recipeWindows} from './reflowBatch';
import type {ReflowRequest} from './reflowTypes';
import type {PageRunPlan} from '../contentStreamEdit/pageRunPlan';
const overlaps=(a:PdfRect,b:PdfRect)=>a.x<b.x+b.w && b.x<a.x+a.w && a.y<b.y+b.h && b.y<a.y+a.h;
/** All addresses and validation are from one immutable revision. The only
 * installation is the final combined plan, after per-overlay preflight. */
export async function applyContentTextEdits(page:PDFPage,overlays:readonly Overlay[],options:RunPageOptions&{stage5Reflow?:boolean;reflowRequests?:ReadonlyMap<string,ReflowRequest>}={}){
 const edits=overlays.filter((o):o is ContentTextOverlay=>o.type==='contentText'),accepted=new Set<string>();
 const outcomes=new Map<string,ContentTextOutcome>(),plans=new Map<string,PageRunPlan>(),changesAdvance=new Set<string>();
 if(!edits.length)return{outcomes:[],remaining:[...overlays]};
 const source=inspectRunPage(page);
 if(!source.ok)return{outcomes:edits.map(o=>({overlayId:o.id,mode:'overlay' as const,reason:'unsupported-state' as const,detail:source.reason})),remaining:[...overlays]};
 const fonts=resolveRunFonts(page,options.stage5Type1),environment=runPageEnvironment(page),ops=tokenizeContentStream(source.bytes),scopes=textObjectScopes(ops);
 const objectScopes=new Map<string,Set<number>>();
 const walk=walkTextPlacements(ops,{resolveFont:name=>{const f=fonts.find(f=>f.resourceName===name);return f?{...f,ok:true,appliesWordSpacing:f.bytesPerCode===1}:{ok:false,reason:'unsupported font'};},extGStateSetsFont:name=>environment.extGStates?.get(name)?.setsFont??null});
 for(const overlay of edits){
  const touched=walk.ok?walk.glyphs.filter(g=>overlay.coverRects.some(r=>quadIntersectsRect(g.quad,r))).map(g=>scopes.get(g.opIndex)!):[];
  objectScopes.set(overlay.id,new Set(touched.length?touched:[...scopes.values()]));
  if(edits.some(other=>other!==overlay && other.coverRects.some(b=>overlay.coverRects.some(a=>overlaps(a,b))))){outcomes.set(overlay.id,{overlayId:overlay.id,mode:'overlay',reason:'ambiguous-match'});continue;}
  let planned=planContentText(source.bytes,fonts,overlay,{...environment,stage5Reflow:options.stage5Reflow,reflowRequest:options.reflowRequests?.get(overlay.id)});
  if(!planned.ok){outcomes.set(overlay.id,{overlayId:overlay.id,mode:'overlay',reason:planned.code,detail:planned.reason});continue;}
  let result=await compileRunPageWithFallback(page,planned.plan,options);
  if(!result.ok&&result.code==='overflow'&&options.stage5Reflow&&!/[\r\n]/u.test(overlay.originalText)&&!options.reflowRequests?.has(overlay.id)){
   const spacing=planOriginalSlotSpacing(page,source.bytes,fonts,planned.plan);
   if(spacing){planned={ok:true,plan:spacing};result=await compileRunPageWithFallback(page,spacing,options);}
  }
  if(!result.ok){outcomes.set(overlay.id,{overlayId:overlay.id,mode:'overlay',reason:compilerReason(result),detail:result.reason});continue;}
  plans.set(overlay.id,planned.plan);objectScopes.set(overlay.id,new Set(planned.plan.edits.map(e=>scopes.get(e.opIndex)!)));
  if(result.usedFallback||planned.plan.reflow)changesAdvance.add(overlay.id);
  else for(const edit of planned.plan.edits){const font=fonts.find(f=>f.resourceName===edit.fontResource)!;const encoded=encodeRun(edit.replacement,font,edit.expected,planned.plan.allowExistingCodePermutation);
   const advance=(data:Uint8Array)=>codes(data,font.bytesPerCode).reduce((n,c)=>n+font.widthOf(c),0);
   if(!encoded.ok || advance(encoded.bytes)!==advance(edit.expected) || codes(encoded.bytes,font.bytesPerCode).filter(c=>c===32).length!==codes(edit.expected,font.bytesPerCode).filter(c=>c===32).length || encoded.bytes.length!==edit.expected.length)changesAdvance.add(overlay.id);
  }
  outcomes.set(overlay.id,{overlayId:overlay.id,mode:result.usedFallback?'fallback-font':'in-place'});
 }
 // Operator ownership is larger than the UI selection. Reject BOTH original
 // plans when a recipe tail intersects another plan, even with disjoint covers.
 const conflicts=new Set<string>();
 for(const [id,p]of plans)for(const [other,q]of plans)if(id!==other&&recipeWindows(p).some(w=>
  q.edits.some(e=>e.opIndex>=w.first&&e.opIndex<=w.last)||recipeWindows(q).some(v=>v.first<=w.last&&w.first<=v.last))){conflicts.add(id);conflicts.add(other);}
 for(const id of conflicts){plans.delete(id);outcomes.set(id,{overlayId:id,mode:'overlay',reason:'reflow-required',detail:'intersecting owned reflow tails'});}
 // A hybrid sibling can only run on original geometry. Downgrades propagate
 // until no changing-advance plan shares an object with any refusal.
 let changed=true;
 while(changed){changed=false;for(const id of [...plans.keys()])if(changesAdvance.has(id) && edits.some(o=>!plans.has(o.id) && [...objectScopes.get(o.id)!].some(s=>objectScopes.get(id)!.has(s)))){
  plans.delete(id);outcomes.set(id,{overlayId:id,mode:'overlay',reason:'shared-text-object'});changed=true;
 }}
 if(plans.size){
  const plan:PageRunPlan={sourceHash:source.sourceHash,allowExistingCodePermutation:true,...environment,edits:[...plans.values()].flatMap(p=>p.edits),reflows:[...plans.values()].flatMap(p=>p.reflow?[p.reflow]:[])};
  const result=await replaceRunPageWithFallback(page,plan,options);
  if(result.ok)for(const [id,p]of plans){accepted.add(id);if(p.reflow&&walk.ok)outcomes.set(id,{...outcomes.get(id)!,reflow:reflowManifest(p.reflow,walk.glyphs,fonts)});}
  else for(const id of plans.keys())outcomes.set(id,{overlayId:id,mode:'overlay',reason:compilerReason(result),detail:result.reason});
 }
 return{outcomes:edits.map(o=>outcomes.get(o.id)!),remaining:overlays.filter(o=>!accepted.has(o.id))};
}
