import type {ParagraphLine,Rect,TextTrace,VisualGroup} from './types';
import {contains,EPS,lineStart,near,paragraphMember,physicalSize} from './geometry';
import {queryOccupancy,type PageOccupancy} from './occupancy';
import {leftTolerance,visualLineEnd} from './visualGroups';

type Witness={group:VisualGroup;line:ParagraphLine;left:number;end:number;y:number};
/** Other groups supply an observed column edge, never a margin estimate.
 * No capacity is granted by raster or by a line's declared advance alone. */
export function proveOneLineCapacity(group:VisualGroup,groups:readonly VisualGroup[],ends:ReadonlyMap<number,TextTrace>,
 index:PageOccupancy,crop:Rect,clip:Rect):void{
 if(group.refusal||group.lines.length!==1)return;
 const target=group.lines[0]!,ownEnd=group.capacityRight,tol=leftTolerance(group.style),indent=2.5*physicalSize(group.style);
 const diagnostics={slack:0,witnessGroups:0,sourceGapBefore:!!target.sourceGapBefore};
 group.columnEvidence=diagnostics;
 const all:Witness[]=groups.flatMap(g=>g.lines.map(line=>({group:g,line,left:lineStart(line,true)[0],end:visualLineEnd(line,ends),y:lineStart(line,true)[1]})));
 const sameStyle=(w:Witness)=>!w.group.refusal&&w.line.shows.every(s=>paragraphMember(s.before,group.style)&&paragraphMember(s.after,group.style));
 const witnesses=all.filter(w=>w.group!==group&&sameStyle(w)&&!w.line.shows.every(s=>/^\s*$/u.test(s.unicode)));
 const targetY=lineStart(target,true)[1],byShow=new Map<string,Witness[]>();
 for(const w of all)for(const s of w.line.shows){const key=`${s.source.opIndex}:${s.source.itemIndex}`,list=byShow.get(key)??[];list.push(w);byShow.set(key,list);}
 const candidates:{x0:number;right:number;members:Witness[]}[]=[];
 for(const x0 of new Set(witnesses.map(w=>w.left))){
  if(group.firstLeft<x0-tol-EPS||group.firstLeft>x0+indent+EPS)continue;
  const aligned=witnesses.filter(w=>near(w.left,x0,tol)).sort((a,b)=>a.end-b.end);
  diagnostics.witnessGroups=Math.max(diagnostics.witnessGroups,new Set(aligned.map(w=>w.group)).size);
  // Each cluster has diameter <= .25 pt and two DISTINCT groups. Use its
  // leftmost end: tolerance never adds unobserved space to the right.
  for(const w of aligned){
   const members=aligned.filter(v=>v.end>=w.end&&v.end<=w.end+.25+EPS);
   if(new Set(members.map(v=>v.group)).size>=2)candidates.push({x0,right:w.end,members});
  }
 }
 if(!candidates.length){group.columnEvidence={...diagnostics,reason:'No edge reached by two distinct groups'};return;}
 // Conflicting witnessed edges resolve to the leftmost edge, including
 // across overlapping left-alignment clusters. Never cherry-pick a wider R.
 candidates.sort((a,b)=>a.right-b.right||b.members.length-a.members.length||a.x0-b.x0);
 const chosen=candidates[0]!,{x0,right,members}=chosen;
 const fail=(reason:string)=>{group.columnEvidence={...diagnostics,reason};};
 if(right<x0||!contains(crop,{x:x0,y:targetY,w:right-x0,h:0})||!contains(clip,{x:x0,y:targetY,w:right-x0,h:0})){
  fail('Witness edge outside crop or clip');return;
 }
 // A measured multi-line pitch or explicit TL is needed for locality. A
 // paragraph gap alone is not evidence of the ordinary line pitch.
 const pitches=[group.pitchPt,...witnesses.map(w=>w.group.pitchPt)].filter(p=>p>0);
 const pitch=pitches.length?Math.min(...pitches):0;
 const nearest=[...members].sort((a,b)=>Math.abs(a.y-targetY)-Math.abs(b.y-targetY))[0]!;
 if(!pitch||Math.abs(nearest.y-targetY)>4*pitch+EPS){fail('No witness within four proved pitches');return;}
 if(!target.ink||!nearest.line.ink){fail('Missing target or witness ink band');return;}
 const band=(line:ParagraphLine)=>({bottom:line.ink!.y-index.guardPt,top:line.ink!.y+line.ink!.h+index.guardPt});
 const a=band(target),b=band(nearest.line);
 if(nearest.y<targetY?b.top>a.bottom:b.bottom<a.top){fail('Target and witness bands overlap');return;}
 // Include the witness band itself so side-by-side text at its baseline
 // cannot masquerade as a single column witness. The target band is capped
 // separately by capVisualSlots, including obstacles beside its short end.
 const bottom=nearest.y<targetY?b.bottom:a.top,top=nearest.y<targetY?a.bottom:b.top;
 const strip={x:x0,y:bottom,w:right-x0,h:top-bottom};
 if(!contains(crop,strip)||!contains(clip,strip)){fail('Witness strip outside crop or clip');return;}
 const allowed=(w:Witness)=>sameStyle(w)&&w.left>=x0-tol-EPS&&w.left<=x0+indent+EPS&&w.end<=right+tol+EPS;
 const inStrip=new Set<Witness>();
 for(const o of queryOccupancy(index,strip)){
  if(!o.owner||!['glyph','placement'].includes(o.kind)){fail('Non-text occupant in witness strip');return;}
  const parts=o.owner.split(':'),lines=byShow.get(`${parts[0]}:${parts[1]}`);
  if(!lines||lines.length!==1){fail('Unknown text line in witness strip');return;}
  const w=lines[0]!;
  if(w.line===target)continue;
  if(!allowed(w)){fail('Text crosses the witnessed column in strip');return;}
  inStrip.add(w);
 }
 const rows=[...inStrip];
 if(rows.some((w,i)=>rows.slice(i+1).some(v=>near(w.y,v.y,.25)))){fail('Side-by-side lines in witness strip');return;}
 group.capacityRight=Math.max(ownEnd,right);group.column={x0,x1:group.capacityRight};
 group.columnEvidence={slack:right-ownEnd,witnessGroups:new Set(members.map(w=>w.group)).size,sourceGapBefore:!!target.sourceGapBefore,right};
}
