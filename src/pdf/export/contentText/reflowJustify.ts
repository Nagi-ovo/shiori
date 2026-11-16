import type {MeasuredCluster} from './reflowLayout';
import type {LineSlot} from './regionProof';

/** Leading space's left ink edge, expressed in the suffix's source frame
 * (positioned replacement ink right minus delta). */
export type SuffixGlueRow=Readonly<LineSlot>&{previousInkRight?:number};
export type SuffixGluePlan={reductions:number[];shifts:number[]};
const EPS=1e-7;
const nonSpace=(t:MeasuredCluster)=>!!t.unicode&&!/\s/u.test(t.unicode)&&!t.wordSpace;
const paints=(t:MeasuredCluster)=>t.ink.w>0&&t.ink.h>0;

/** Retained suffix only. Advances/metrics/codes never change: reductions are
 * positioning glue after each token. No scene or ownership is inferred here.
 * The caller still proves every destination against the immutable scene. */
export function planSuffixGlue(tokens:readonly MeasuredCluster[],row:SuffixGlueRow,delta:number):SuffixGluePlan|null{
 if(!tokens.length||!Number.isFinite(delta)||delta<=0||
  ![row.left,row.right,row.baseline].every(Number.isFinite)||row.right<=row.left||
  delta>.02*(row.right-row.left))return null;
 const line=tokens[0]!.original?.line;
 if(line===undefined||tokens.some(t=>!t.original||t.original.line!==line||
  Math.abs(t.original.y-row.baseline)>.01||t.hardAfter||!t.unicode||
  ![t.original.x,t.original.y,t.advance,t.gap,t.em,t.ink.x,t.ink.y,t.ink.w,t.ink.h].every(Number.isFinite)||
  t.advance<=0||t.em<=0||t.ink.w<0||t.ink.h<0||t.original.x<row.left-EPS||
  t.original.x+Math.max(t.advance,t.ink.x+t.ink.w)>row.right+EPS))return null;
 const tiers:{index:number;cap:number;width:number;clearance:number;em:number}[][]=[[],[]];
 for(let i=0;i<tokens.length-1;i++){
  const t=tokens[i]!,next=tokens[i+1]!,previous=tokens[i-1];
  if(next.original!.x<t.original!.x||
   Math.abs(next.original!.x-t.original!.x-t.advance-t.gap)>EPS)return null;
  if(t.lockedAfter)continue;
  const literal=t.wordSpace&&t.code?.length===1&&t.code[0]===32&&t.unicode===' '&&!paints(t)&&
   (!previous||nonSpace(previous)&&paints(previous))&&nonSpace(next)&&paints(next);
  const tj=t.tjGap&&t.gap>=.2*t.em&&nonSpace(t)&&nonSpace(next)&&paints(t)&&paints(next);
  if(!literal&&!tj)continue;
  const left=literal?(previous?previous.original!.x+previous.ink.x+previous.ink.w:row.previousInkRight):
   t.original!.x+t.ink.x+t.ink.w;
  if(left===undefined||!Number.isFinite(left))continue;
  const width=literal?t.advance+t.gap:t.gap,clearance=next.original!.x+next.ink.x-left;
  const cap=Math.min(.05*t.em,.2*width,width-.2*t.em,clearance-.01*t.em);
  // Include floor-bound eligible glue in the uniform tier: never tighten
  // other gaps around a zero cap and destroy the justified line's evenness.
  tiers[literal?0:1]!.push({index:i,cap:Math.max(0,cap),width,clearance,em:t.em});
 }
 const gaps=tiers.flat(),capacity=gaps.reduce((n,g)=>n+g.cap,0);
 const roundoff=Number.EPSILON*Math.max(1,delta,capacity)*Math.max(1,gaps.length)*4;
 if(!gaps.length||delta-capacity>roundoff)return null;
 const reductions=tokens.map(()=>0);let remaining=delta;
 for(const tier of tiers){
  if(!tier.length)continue;
  const reduction=Math.min(...tier.map(g=>g.cap),remaining/tier.length);
  for(const g of tier)reductions[g.index]=reduction;
  remaining=Math.max(0,remaining-reduction*tier.length);
  if(!remaining)break;
 }
 const absorbed=reductions.reduce((n,r)=>n+r,0);
 if(!(absorbed>0)||Math.abs(delta-absorbed)>EPS)return null;
 if(gaps.some(g=>g.width-reductions[g.index]!<.2*g.em-EPS||
  g.clearance-reductions[g.index]!<.01*g.em-EPS))return null;
 // Snap only the exhausted tail; never leave a sub-EPS shift on the last
 // word. The first shift is delta and all intermediate shifts use the sum.
 const shifts=tokens.map(()=>0),last=reductions.findLastIndex(r=>r>0);let used=0;
 for(let i=0;i<=last;i++){shifts[i]=Math.max(0,delta-used);used+=reductions[i]!;}
 return {reductions,shifts};
}
