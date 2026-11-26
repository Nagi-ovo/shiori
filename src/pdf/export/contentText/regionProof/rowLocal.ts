import type {StreamReflowEvidence} from '../reflowEvidence';
import type {LineSlot,ParagraphLine,Rect,RegionProof,TextTrace,VisualGroup} from './types';
import {EPS,contains,intersectRect,intersects,lineStart,near,subtractRectangles,validRect} from './geometry';
import {queryOccupancy,type PageOccupancy} from './occupancy';
import {visualLineEnd} from './visualGroups';

/** Restore only a single row's observed extent after the coarse cap. No
 * witness/column width is borrowed; destination authority remains per glyph. */
export function proveRowLocalSlot(group:VisualGroup,lines:readonly ParagraphLine[],index:PageOccupancy,
 owners:ReadonlySet<string>,ends:ReadonlyMap<number,TextTrace>):{ok:true;slot:LineSlot}|{ok:false;reason:string}{
 const fail=(reason:string)=>({ok:false as const,reason});
 if(index.pageBlocked||group.refusal||lines.length!==1)return fail('Blocked, unordered or multi-row window');
 const line=lines[0]!;
 if(!line.ink||!validRect(line.ink)||!line.shows.length||!owners.size||
  line.shows.some(s=>!index.embeddedFonts.has(s.source.fontObject)))return fail('Missing measured embedded source row');
 if([...owners].some(owner=>!index.glyphs.get(owner)?.ink))return fail('Unmeasured source glyph');
 const [left,baseline]=lineStart(line,true),right=visualLineEnd(line,ends);
 if(![left,right,baseline].every(Number.isFinite)||right<=left)return fail('Invalid observed row extent');
 for(const [owner,glyph]of index.glyphs){
  if(owners.has(owner)||!near(glyph.baseline,baseline,.01))continue;
  const p=glyph.placement;
  if(!validRect(p)||p.x<right-EPS&&p.x+p.w>left+EPS)return fail('Interleaved unowned same-baseline placement');
 }
 return {ok:true,slot:{left,right,baseline,kind:'observed-row'}};
}

/** No-worse-than-source is limited to the guard ring. Actual stationary
 * ink always blocks, even where the vacated source itself overlapped it. */
export function rowLocalDestination(e:StreamReflowEvidence,proof:RegionProof,ink:Rect,placement:Rect,
 vacated:ReadonlySet<string>,oldInk:readonly Rect[]):boolean{
 const slot=proof.lineSlots[0],band=e.lines[0]?.ink,index=e.occupancy;
 if(proof.lineSlots.length!==1||e.lines.length!==1||!slot||!band||
  placement.x<slot.left-EPS||placement.x+placement.w>slot.right+EPS||
  ink.w>0&&ink.h>0&&!contains({x:slot.left,y:band.y,w:slot.right-slot.left,h:band.h},ink))return false;
 for(const [owner,glyph]of index.glyphs){
  const p=glyph.placement;
  if(!vacated.has(owner)&&near(glyph.baseline,slot.baseline,.01)&&
   placement.x<p.x+p.w&&p.x<placement.x+placement.w)return false;
 }
 if(ink.w<=0||ink.h<=0)return true;
 for(const obstacle of queryOccupancy(index,ink)){
  if(obstacle.kind==='placement'||obstacle.kind==='backdrop'||obstacle.owner&&vacated.has(obstacle.owner))continue;
  const b=obstacle.box,g=index.guardPt,core={x:b.x+g,y:b.y+g,w:b.w-2*g,h:b.h-2*g};
  if(core.w>0&&core.h>0&&intersects(ink,core))return false;
  const overlap=intersectRect(ink,b);
  if(overlap&&subtractRectangles(overlap,oldInk).length)return false;
 }
 return true;
}
