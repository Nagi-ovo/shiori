import type {PDFPage} from 'pdf-lib';
import type {ResolvedRunFont} from '../contentStreamEdit/replaceRun';
import {retypesetPaintedInk} from './retypesetInk';
import type {planRetypesetPush,RetypesetChainRules} from './retypesetPush';

type Push=ReturnType<typeof planRetypesetPush>;
/** Failure outcomes a same-column chain may replace. Every other outcome
 * (a push, a frame tighten, an envelope fit, a clear row, unknown output or
 * source ink, a bounded frame, several edited blocks) is never revisited. */
export const RETYPESET_CHAIN_REASONS=new Set(['foreign-column-or-obstacle','fixed-or-foreign-obstacle','unpushable-ink','destination-overlap'].map(r=>`push-blocked-by-${r}`));
export function retypesetChainEligible(push:Push){
 return!push.pushed&&push.overflowInkOverlap&&!!push.pushReason&&RETYPESET_CHAIN_REASONS.has(push.pushReason);
}
export function retypesetChainRules(page:PDFPage,fonts:ResolvedRunFont[]):Omit<RetypesetChainRules,'stopOnPainted'>{
 // Built on first use: most rows never reach a chain or an unknown glyph.
 let painted:ReturnType<typeof retypesetPaintedInk>|undefined;
 return{painted:g=>(painted??=retypesetPaintedInk(page,fonts))(fonts.find(f=>f.resourceName===g.glyph.fontName)!,g.glyph.code,g.state,g.x,g.y)};
}
/** The chain first grows its band exactly as an existing push does and
 * proves the result on painted coverage; only if that fails does it grow
 * the band by painted coverage too. A push that already succeeds therefore
 * takes the first attempt with an unchanged moved set. `accept` can refuse
 * an attempt; the next one (or none) is then used. */
export function planRetypesetChain(plan:(rules:RetypesetChainRules)=>Push,rules:Omit<RetypesetChainRules,'stopOnPainted'>,accept:(push:Push)=>boolean=()=>true){
 const first=plan({...rules,stopOnPainted:false});
 if(first.pushed&&accept(first))return first;
 const second=plan({...rules,stopOnPainted:true});
 return second.pushed&&!accept(second)?{...second,pushed:false,pushReason:'push-blocked-by-unpainted-follower'}:second;
}
/** A new rescue never moves a unit that paints nothing: it cannot obstruct,
 * and a moved glyph with no rendered ink has no independent evidence of its
 * destination. Existing pushes are not subject to this. */
export const retypesetChainRescue=(push:Push)=>push.regions.every(r=>r.before.w>0&&r.before.h>0);
/** Same moved set, one delta, the same byte patches and regions. */
export function sameRetypesetPush(a:Push,b:Push){
 const map=(m:Map<unknown,number>)=>JSON.stringify([...m].sort((x,y)=>String(x[0]).localeCompare(String(y[0]))));
 return a.pushed===b.pushed&&a.pushedDeltaPt===b.pushedDeltaPt&&map(a.glyphDeltas)===map(b.glyphDeltas)&&map(a.paintDeltas)===map(b.paintDeltas)&&
  JSON.stringify(a.patches)===JSON.stringify(b.patches)&&JSON.stringify(a.regions)===JSON.stringify(b.regions);
}
/** Shadow observer. When set, every successful existing push is re-planned
 * under the chain rules and reported with it (output still comes from the
 * existing push), as is every chain attempt on a failure row. Probes and
 * tests set it; production leaves it unset. */
export const retypesetChainShadow:{observe?:(existing:Push,chain:Push)=>void}={};
