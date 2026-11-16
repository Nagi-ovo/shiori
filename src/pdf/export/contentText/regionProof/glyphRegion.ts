import type {StreamReflowEvidence} from '../reflowEvidence';
import type {ReflowCodeCluster} from '../reflowTypes';
import type {Rect,RegionProof} from './types';
import {contains,intersects,paragraphMember} from './geometry';
import {atOrigin,boundBoxes,dilateInk,glyphKey,placementBox,queryOccupancy} from './occupancy';

export type GlyphRegion={old:Rect[];new:Rect[];mask:Rect[]};
/** Obligations 3–5. Layout grants no empty space: changed glyphs must pass
 * the analytic index, then their old/new mask is fixed before compilation. */
export function proveGlyphRegion(e:StreamReflowEvidence,proof:RegionProof,clusters:readonly ReflowCodeCluster[],
 origins:readonly (readonly [number,number])[],replaced:readonly ReflowCodeCluster[]):RegionProof|null{
 const index=e.occupancy;
 if(index.pageBlocked||proof.occupancyHash!==index.hash||origins.length!==clusters.length)return null;
 const changed=clusters.map((t,i)=>!t.original||origins[i]![0]!==t.original.x||origins[i]![1]!==t.original.y);
 const moved=clusters.filter((t,i)=>t.source&&changed[i]),vacated=new Set([...moved,...replaced].map(t=>glyphKey(t.source!)));
 const region:GlyphRegion={old:[],new:[],mask:[]};
 for(const t of [...moved,...replaced]){
  if(!t.source||!t.original||!index.embeddedFonts.has(t.fontObject))return null;
  const state=e.trace.shows.get(`${t.source.opIndex}:${t.source.itemIndex}`),measured=index.glyphs.get(glyphKey(t.source))?.ink;
  if(!state||!paragraphMember(state.before,e.target)||!paragraphMember(state.after,e.target)||!measured||!t.unicode)return null;
  if(measured.box.w>0&&measured.box.h>0)region.old.push(dilateInk(atOrigin(measured.box,t.original.x,t.original.y),index.guardPt));
 }
 for(let i=0;i<clusters.length;i++){
  if(!changed[i])continue;
  const t=clusters[i]!,p=origins[i]!,op=t.source?.opIndex??t.homeOp;
  const state=[...e.trace.shows.values()].find(s=>s.before.opIndex===op)?.before,font=e.fonts.find(f=>f.objectId===t.fontObject&&f.resourceName===t.fontResource);
  if(!state||!font||!index.embeddedFonts.has(font.objectId)||!p.every(Number.isFinite))return null;
  const code=font.bytesPerCode===1?t.code[0]!:t.code[0]!*256+t.code[1]!,measured=e.ink(font.resourceName,code,state);
  if(!measured||font.unicodeByCode.get(code)!==t.unicode)return null;
  if(measured.box.w>0&&measured.box.h>0){
   const box=dilateInk(atOrigin(measured.box,p[0],p[1]),index.guardPt);
   if(queryOccupancy(index,box).some(o=>o.kind!=='placement'&&(!o.owner||!vacated.has(o.owner))))return null;
   region.new.push(box);
  }
  const placement=placementBox(font,state,code,p[0],p[1]);
  if(queryOccupancy(index,placement).some(o=>o.kind==='placement'&&(!o.owner||!vacated.has(o.owner))))return null;
 }
 // Check new/new ink as well as new/stationary ink. Preserve existing
 // overlaps only when both retained glyphs keep their relative origins.
 const ink=clusters.map((t,i)=>atOrigin(t.ink,origins[i]![0],origins[i]![1]));
 for(let i=0;i<clusters.length;i++)for(let j=i+1;j<clusters.length;j++){
  if(!changed[i]&&!changed[j]||!ink[i]!.w||!ink[i]!.h||!ink[j]!.w||!ink[j]!.h||!intersects(ink[i]!,ink[j]!))continue;
  const a=clusters[i]!.original,b=clusters[j]!.original,p=origins[i]!,q=origins[j]!;
  if(!a||!b||Math.abs(p[0]-q[0]-(a.x-b.x))>1e-7||Math.abs(p[1]-q[1]-(a.y-b.y))>1e-7)return null;
 }
 region.mask=[...region.old,...region.new];
 if(!region.mask.length||region.mask.some(b=>!contains(e.crop,b)||!contains(e.media,b)))return null;
 return {...proof,mask:region.mask,box:boundBoxes(region.mask),occupancyHash:index.hash};
}
