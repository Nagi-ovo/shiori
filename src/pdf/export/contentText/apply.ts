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
import type {PageRunPlan} from '../contentStreamEdit/pageRunPlan';
const overlaps=(a:PdfRect,b:PdfRect)=>a.x<b.x+b.w && b.x<a.x+a.w && a.y<b.y+b.h && b.y<a.y+a.h;
/** All addresses and validation are from one immutable revision. The only
 * installation is the final combined plan, after per-overlay preflight. */
export async function applyContentTextEdits(page:PDFPage,overlays:readonly Overlay[],options:RunPageOptions={}){
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
  const planned=planContentText(source.bytes,fonts,overlay,environment);
  if(!planned.ok){outcomes.set(overlay.id,{overlayId:overlay.id,mode:'overlay',reason:planned.code,detail:planned.reason});continue;}
  const result=await compileRunPageWithFallback(page,planned.plan,options);
  if(!result.ok){outcomes.set(overlay.id,{overlayId:overlay.id,mode:'overlay',reason:compilerReason(result),detail:result.reason});continue;}
  plans.set(overlay.id,planned.plan);objectScopes.set(overlay.id,new Set(planned.plan.edits.map(e=>scopes.get(e.opIndex)!)));
  if(result.usedFallback)changesAdvance.add(overlay.id);
  else for(const edit of planned.plan.edits){const font=fonts.find(f=>f.resourceName===edit.fontResource)!;const encoded=encodeRun(edit.replacement,font,edit.expected,planned.plan.allowExistingCodePermutation);
   const advance=(data:Uint8Array)=>codes(data,font.bytesPerCode).reduce((n,c)=>n+font.widthOf(c),0);
   if(!encoded.ok || advance(encoded.bytes)!==advance(edit.expected) || codes(encoded.bytes,font.bytesPerCode).filter(c=>c===32).length!==codes(edit.expected,font.bytesPerCode).filter(c=>c===32).length || encoded.bytes.length!==edit.expected.length)changesAdvance.add(overlay.id);
  }
  outcomes.set(overlay.id,{overlayId:overlay.id,mode:result.usedFallback?'fallback-font':'in-place'});
 }
 // A hybrid sibling can only run on original geometry. Downgrades propagate
 // until no changing-advance plan shares an object with any refusal.
 let changed=true;
 while(changed){changed=false;for(const id of [...plans.keys()])if(changesAdvance.has(id) && edits.some(o=>!plans.has(o.id) && [...objectScopes.get(o.id)!].some(s=>objectScopes.get(id)!.has(s)))){
  plans.delete(id);outcomes.set(id,{overlayId:id,mode:'overlay',reason:'shared-text-object'});changed=true;
 }}
 if(plans.size){
  const plan:PageRunPlan={sourceHash:source.sourceHash,allowExistingCodePermutation:true,...environment,edits:[...plans.values()].flatMap(p=>p.edits)};
  const result=await replaceRunPageWithFallback(page,plan,options);
  if(result.ok)for(const id of plans.keys())accepted.add(id);
  else for(const id of plans.keys())outcomes.set(id,{overlayId:id,mode:'overlay',reason:compilerReason(result),detail:result.reason});
 }
 return{outcomes:edits.map(o=>outcomes.get(o.id)!),remaining:overlays.filter(o=>!accepted.has(o.id))};
}
