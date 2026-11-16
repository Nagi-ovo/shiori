import type {TextTrace,VisualGroup} from './types';
import {EPS,lineStart,near,physicalLeading,physicalSize} from './geometry';
import {leftTolerance,pitchTolerance} from './visualGroups';
import {columnLines,nonblankWitness,sameColumnStyle,type ColumnWitness} from './columnWitnesses';

type Gap={upper:ColumnWitness;lower:ColumnWitness;pitch:number};
/** A grouping pitch may come from one gap; it never proves an extra row.
 * Use an explicit positive text-state leading, or a unique modal cluster of
 * at least two distinct, agreeing gaps. No em-based pitch is synthesized.
 * Locality uses the existing four-pitch column horizon, measured from the
 * target group's band. Both endpoints of every supporting gap must fit it.
 */
export function proveGroupLeading(group:VisualGroup,groups:readonly VisualGroup[],ends:ReadonlyMap<number,TextTrace>,style=group.style):void{
 const unproved=(reason:string)=>{group.leadingEvidence={kind:'unproved',pitchPt:0,gapCount:0,reason};};
 if(group.refusal){unproved(group.refusal);return;}
 const explicit=physicalLeading(style);
 if(explicit>0){group.leadingEvidence={kind:'explicit',pitchPt:explicit,gapCount:0};return;}
 const tol=leftTolerance(style),indent=2.5*physicalSize(style);
 const rows=columnLines(groups,ends).filter(w=>
  w.left>=group.firstLeft-indent-tol-EPS&&w.left<=group.firstLeft+tol+EPS&&w.end>group.firstLeft+EPS);
 const ys=group.lines.map(l=>lineStart(l,true)[1]),bottom=Math.min(...ys),top=Math.max(...ys);
 const distance=(w:ColumnWitness)=>Math.max(bottom-w.y,w.y-top,0);
 const columns:Gap[][]=[];
 for(const x0 of new Set(rows.map(w=>w.left))){
  if(group.firstLeft<x0-tol-EPS||group.firstLeft>x0+indent+EPS)continue;
  const aligned=rows.filter(w=>near(w.left,x0,tol)).sort((a,b)=>b.y-a.y);
  const gaps:Gap[]=[];
  for(let i=1;i<aligned.length;i++){
   const upper=aligned[i-1]!,lower=aligned[i]!,pitch=upper.y-lower.y;
   // Adjacent visual rows must also advance in source order. Blank rows,
   // overlaps and positive explicit leading inconsistent with this gap do
   // not become modal evidence (in particular repeated paragraph gaps).
   if(![upper,lower].every(w=>sameColumnStyle(w,style)&&nonblankWitness(w))||lower.line.sourceGapBefore||
    !(pitch>0)||upper.line.shows.at(-1)!.source.opIndex>=lower.line.anchor.opIndex||
    !upper.line.ink||!lower.line.ink||lower.line.ink.y+lower.line.ink.h>upper.line.ink.y||
    Math.max(distance(upper),distance(lower))>4*pitch+EPS)continue;
   const leading=[...upper.line.shows,...lower.line.shows].flatMap(s=>[physicalLeading(s.before),physicalLeading(s.after)]);
   if(leading.some(p=>p>0&&!near(p,pitch,pitchTolerance(p))))continue;
   gaps.push({upper,lower,pitch});
  }
  columns.push(gaps);
 }
 // A cluster has bounded diameter; a chain of near neighbours cannot join
 // incompatible pitches. Select an observed median, never a made-up mean.
 // Never pool isolated gaps from different left-edge clusters.
 const clusters=columns.flatMap(gaps=>gaps.map(g=>gaps.filter(v=>v.pitch>=g.pitch&&v.pitch-g.pitch<=pitchTolerance(g.pitch)+EPS)))
  .filter(c=>c.length>=2).sort((a,b)=>b.length-a.length);
 const best=clusters[0];if(!best){unproved('Fewer than two agreeing same-font column gaps');return;}
 const pitch=[...best].sort((a,b)=>a.pitch-b.pitch)[Math.floor((best.length-1)/2)]!.pitch;
 if(clusters.some(c=>c.length===best.length&&!near(c[0]!.pitch,pitch,pitchTolerance(pitch)))){
  unproved('Equally supported column pitches');return;
 }
 if(group.lines.length>1&&!near(pitch,group.pitchPt,pitchTolerance(pitch))){
  unproved('Column pitch differs from the observed group');return;
 }
 group.leadingEvidence={kind:'baseline-gaps',pitchPt:pitch,gapCount:best.length};
}
