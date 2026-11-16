import type {ParagraphLine,TextTrace,VisualGroup,LineSlot} from './types';
import {EPS,lineStart,near,origin,paragraphMember,physicalLeading,physicalSize} from './geometry';
import {queryOccupancy,type PageOccupancy} from './occupancy';

const pitchTolerance=(pitch:number)=>Math.min(.25,Math.max(.10,pitch*.01));
const leftTolerance=(style:TextTrace)=>Math.min(.50,Math.max(.25,.025*physicalSize(style)));
/** Source order is authoritative. A boundary ends the group immediately;
 * disconnected/interleaved columns cannot be rescued by a shorter window. */
export function buildVisualGroups(lines:readonly ParagraphLine[],target:TextTrace,ends:ReadonlyMap<number,TextTrace>):
 {ok:true;groups:VisualGroup[]}|{ok:false;detail:string}{
 const groups:VisualGroup[]=[];
 const style=(line:ParagraphLine)=>line.shows.find(s=>paragraphMember(s.before,target))?.before??line.shows[0]!.before;
 const extent=(line:ParagraphLine)=>Math.max(...line.shows.map(s=>origin(s.after)[0]),
  origin(ends.get(line.shows.at(-1)!.source.opIndex)??line.shows.at(-1)!.after)[0],line.ink?line.ink.x+line.ink.w:-Infinity);
 for(let i=0;i<lines.length;i++){
  const line=lines[i]!,s=style(line),p=lineStart(line,true),end=extent(line);
  let g=groups.at(-1),split=!g||line.sourceGapBefore||!paragraphMember(s,g.style);
  if(g&&!split){
   const previous=lines[i-1]!,q=lineStart(previous,true),previousEnd=extent(previous);
   if(line.anchor.opIndex<=previous.shows.at(-1)!.source.opIndex)
    return {ok:false,detail:'Source/geometry order inversion'};
   const disconnected=Math.max(p[0],q[0])>=Math.min(end,previousEnd)-EPS;
   if(disconnected&&groups.slice(0,-1).some(earlier=>paragraphMember(s,earlier.style)&&
    earlier.lines.some(l=>{const x=lineStart(l,true)[0];return Math.max(x,p[0])<Math.min(extent(l),end)-EPS;})))
    return {ok:false,detail:'Interleaved columns invert source/geometry order'};
   const pitch=q[1]-p[1],explicit=physicalLeading(s);
   split=disconnected||!(pitch>0)||g.pitchPt>0&&!near(pitch,g.pitchPt,pitchTolerance(g.pitchPt))||
    explicit>0&&g.pitchPt>0&&!near(explicit,g.pitchPt,pitchTolerance(g.pitchPt));
   if(!split&&g.lines.length>=2){
    const lefts=[...g.lines.slice(1).map(l=>lineStart(l,true)[0]),p[0]];
    split=Math.max(...lefts)-Math.min(...lefts)>leftTolerance(g.style)+EPS;
   }
   if(!split&&g.pitchPt===0)g.pitchPt=explicit>0?explicit:pitch;
  }
  if(split){
   g={start:i,end:i+1,lines:[],style:s,pitchPt:physicalLeading(s),capacityRight:end,left:p[0],firstLeft:p[0],
    indent:{kind:'flush',amountPt:0},column:{x0:p[0],x1:end}};
   groups.push(g);
  }
  g!.lines=[...g!.lines,line];g!.end=i+1;g!.capacityRight=Math.max(g!.capacityRight,end);
  const starts=g!.lines.map(l=>lineStart(l,true)[0]),body=starts.slice(1),flush=Math.max(...starts)-Math.min(...starts)<=leftTolerance(g!.style)+EPS;
  g!.left=Math.max(...(body.length?body:starts));g!.firstLeft=starts[0]!;
  g!.indent=flush?{kind:'flush',amountPt:0}:{kind:g!.firstLeft>g!.left?'first-line':'hanging',amountPt:Math.abs(g!.firstLeft-g!.left)};
  if(flush)g!.firstLeft=g!.left=Math.max(...starts);
  g!.column={x0:Math.min(...starts),x1:g!.capacityRight};
 }
 return {ok:true,groups};
}

/** Each row stops at the first analytic occupant. Owned window placements
 * may vacate; every prefix/next group, including invisible paint, stays put. */
export function capVisualSlots(slots:readonly Readonly<LineSlot>[],index:PageOccupancy,owners:ReadonlySet<string>,
 lower:number,upper:number):LineSlot[]{
 return slots.map(slot=>{
  const band={x:slot.left,y:slot.baseline+lower,w:slot.right-slot.left,h:upper-lower};
  const obstacles=queryOccupancy(index,band).filter(o=>!o.owner||!owners.has(o.owner));
  return {...slot,right:Math.min(slot.right,...obstacles.map(o=>Math.max(slot.left,o.box.x)))};
 });
}
