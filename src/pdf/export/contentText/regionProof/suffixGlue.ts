import type {StreamReflowEvidence} from '../reflowEvidence';
import type {ReflowCodeCluster} from '../reflowTypes';
import type {RegionProof} from './types';
import {intersects} from './geometry';
import {atOrigin,dilateInk,glyphKey,queryOccupancy} from './occupancy';

/** Additional M2 refusals. Per-glyph region proof still runs afterward; a
 * clear destination alone cannot prove the absence of inline rise/math or
 * authorize crossing an excluded source placement. */
export function proveSuffixGlueScene(e:StreamReflowEvidence,proof:RegionProof,end:number,
 clusters:readonly ReflowCodeCluster[],origins:readonly (readonly [number,number])[]):boolean{
 const index=e.occupancy,slot=proof.lineSlots[0],band=e.lines[0]?.ink,suffix=e.source.slice(end);
 if(index.pageBlocked||e.visualGroup.refusal||e.lines.length!==1||proof.lineSlots.length!==1||
  !slot||!band||!suffix.length||clusters.length!==origins.length)return false;
 const owners=new Set(e.source.map(t=>glyphKey(t.source!)));
 if(e.source.some(t=>!index.embeddedFonts.has(t.fontObject)||!index.glyphs.get(glyphKey(t.source!))?.ink))return false;
 const range={x:suffix[0]!.original!.x,y:band.y,w:slot.right-suffix[0]!.original!.x,h:band.h};
 for(const [owner,glyph]of index.glyphs){
  if(owners.has(owner))continue;
  const p=glyph.placement;
  if(p.x>=range.x+range.w||p.x+p.w<=range.x)continue;
  if(Math.abs(glyph.baseline-slot.baseline)<=.01)return false;
  const ink=glyph.ink?.box,box=ink&&ink.w>0&&ink.h>0?atOrigin(ink,p.x,glyph.baseline):p;
  if(intersects(range,box))return false;
 }
 if(queryOccupancy(index,range).some(o=>o.kind==='unplaced'||o.kind==='unknown'))return false;
 for(let i=0;i<clusters.length;i++){
  const t=clusters[i]!,p=origins[i]!;
  if(!t.ink.w||!t.ink.h)continue;
  // No no-worse-than-source exception for annotation or paint destinations
  // in this tactic, even if an old glyph occupied the same guard ring.
  const box=dilateInk(atOrigin(t.ink,p[0],p[1]),index.guardPt);
  if(queryOccupancy(index,box).some(o=>o.kind!=='glyph'&&o.kind!=='placement'&&o.kind!=='backdrop'))return false;
 }
 return true;
}
