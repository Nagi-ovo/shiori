import type {PDFPage} from 'pdf-lib';
import type {PdfRect} from '../../model/types';
import type {ContentOp} from '../contentStreamEdit/tokenizer';
import {address,retypesetAdvance,type readRetypesetSource} from './retypesetSource';
import type {planRetypeset} from './retypesetPlan';
import {layoutRetypeset} from './retypesetLayout';
import type {retypesetScopes} from './retypesetScopes';
import {bounds} from './retypesetInk';
import {reflowScene} from './reflowScene';
import {contains,intersectRect,intersects} from './regionProof/geometry';
import type {RetypesetAdjustment,RetypesetCluster,RetypesetEnvelopeFit} from './retypesetTypes';

type Plan=ReturnType<typeof planRetypeset>;
type Source=ReturnType<typeof readRetypesetSource>;
type Ink={box:PdfRect;known:boolean};
type Fit=ReturnType<typeof layoutRetypeset>;
/** `ownBand`: no witnessed measure, so the box is the line's own ink and the
 * ladder may only compact the line in place. */
export type RetypesetEnvelope={box:PdfRect;measure:{left:number;right:number};obstacles:PdfRect[];ownBand?:true};

/** Same floor as frame tightening; the ladder never shrinks below it. */
export const RETYPESET_ENVELOPE_FLOOR=.85;
const TRACKING=[.01,.02,.03];
/** Ordered, stop-at-first-fit. Tracking and word-space reduction never exceed
 * the .03 em frame tightening uses; leading and size never go below .85. */
export function retypesetEnvelopeLadder(){
 const steps:{step:RetypesetEnvelopeFit['step'];adjustment:RetypesetAdjustment}[]=[{step:'rebreak',adjustment:{sizeScale:1,trackingEm:0,wordReductionEm:0}}];
 for(const t of TRACKING)steps.push({step:'tracking',adjustment:{sizeScale:1,trackingEm:t,wordReductionEm:t}});
 const floor=Math.round(RETYPESET_ENVELOPE_FLOOR*100);
 for(let p=99;p>=floor;p--)steps.push({step:'leading',adjustment:{sizeScale:1,trackingEm:.03,wordReductionEm:.03,leadingScale:p/100}});
 for(let p=99;p>=floor;p--)steps.push({step:'shrink',adjustment:{sizeScale:p/100,trackingEm:.03,wordReductionEm:.03}});
 return steps;
}

/** The flow envelope is the measure the paragraph already occupies, from its
 * top down to the first painted object below it. It never extends past ink
 * the column already shows, so a gutter or a neighbouring column is never
 * claimed. A one-line block needs an aligned neighbour line (both edges) as
 * evidence of its measure. Without one, its envelope is its own ink band:
 * measure and box are the line's source ink, so a fit claims no new space,
 * horizontally or vertically, and can never add a row. */
export function retypesetFlowEnvelope(page:PDFPage,ops:ContentOp[],source:Source,plan:Plan,target:ReadonlySet<string>,sourceInk:Map<string,Ink>,outputInk:Ink[]):RetypesetEnvelope|undefined{
 const xAxis=plan.frame.global(1,0),yAxis=plan.frame.global(0,1),{group}=plan;
 if(!(xAxis.x>0)||!(yAxis.y>0)||Math.abs(xAxis.y)>1e-8||Math.abs(yAxis.x)>1e-8)return;
 if(!source.walk.ok||source.walk.unplacedText||!plan.tail.length)return;
 const media=page.getMediaBox(),crop=page.getCropBox();
 const pageBox=intersectRect({x:media.x,y:media.y,w:media.width,h:media.height},{x:crop.x,y:crop.y,w:crop.width,h:crop.height});
 if(!pageBox)return;
 const groupGlyphs=group.lines.flatMap(l=>l.glyphs),groupInk=groupGlyphs.map(g=>sourceInk.get(address(g.glyph)));
 if(groupInk.some(o=>!o?.known))return;
 const size=plan.tail[0]!.state.fontSize,left=group.lines[1]?.x??group.left,right=group.right;
 if(!(right-left>=size))return;
 const stationary=source.glyphs.filter(g=>!target.has(address(g.glyph)));
 if(group.lines.length<2){
  const own=new Set(groupGlyphs.map(g=>address(g.glyph))),rows:{y:number;left:number;right:number;last:number}[]=[];
  for(const g of stationary.filter(g=>!own.has(address(g.glyph)))){
   const p=plan.frame.local(g.x,g.y),end=p.x+retypesetAdvance(g,plan.frame.local);
   const row=rows.find(r=>Math.abs(r.y-p.y)<.05&&p.x-r.last<2*size&&p.x>=r.left);
   if(row){row.right=Math.max(row.right,end);row.last=end;}else rows.push({y:p.y,left:p.x,right:end,last:end});
  }
  const line=group.lines[0]!,tolerance=size/2;
  if(!rows.some(r=>Math.abs(r.left-group.left)<=tolerance&&Math.abs(r.right-right)<=tolerance&&Math.abs(r.y-line.y)<=4*group.pitch))return ownBandEnvelope(page,ops,plan,stationary,sourceInk,groupInk,pageBox);
 }
 const ink=inkBounds(groupInk);
 const x0=Math.min(plan.frame.global(Math.min(left,group.left),0).x,ink.x),x1=Math.max(plan.frame.global(right,0).x,ink.x+ink.w);
 const obstacles=sceneObstacles(page,ops,stationary,sourceInk,pageBox);
 const tailBottom=Math.min(...plan.tail.map(g=>sourceInk.get(address(g.glyph))!.box.y));
 const floor=Math.max(pageBox.y,...obstacles.filter(o=>o.x<x1&&o.x+o.w>x0&&o.y+o.h<=tailBottom+.01).map(o=>o.y+o.h));
 const painted=outputInk.filter(o=>o.box.w>0&&o.box.h>0);
 const top=Math.min(pageBox.y+pageBox.h,Math.max(ink.y+ink.h,...painted.map(o=>o.box.y+o.box.h)));
 const box=intersectRect({x:x0,y:floor,w:x1-x0,h:top-floor},pageBox);
 return box?{box,measure:{left,right},obstacles}:undefined;
}

const inkBounds=(inks:(Ink|undefined)[])=>bounds(inks.flatMap(o=>[{x:o!.box.x,y:o!.box.y},{x:o!.box.x+o!.box.w,y:o!.box.y+o!.box.h}]));
function sceneObstacles(page:PDFPage,ops:ContentOp[],stationary:Source['glyphs'],sourceInk:Map<string,Ink>,pageBox:PdfRect){
 const obstacles=stationary.map(g=>sourceInk.get(address(g.glyph))!.box);
 reflowScene(page,ops,pageBox,(box,kind)=>{if(kind!=='backdrop')obstacles.push(box);},.01);
 return obstacles;
}
function ownBandEnvelope(page:PDFPage,ops:ContentOp[],plan:Plan,stationary:Source['glyphs'],sourceInk:Map<string,Ink>,groupInk:(Ink|undefined)[],pageBox:PdfRect):RetypesetEnvelope|undefined{
 const ink=inkBounds(groupInk),box=intersectRect(ink,pageBox);
 if(!box)return;
 // The frame is axis-aligned with positive scale (checked by the caller).
 const left=plan.frame.local(ink.x,ink.y).x,right=plan.frame.local(ink.x+ink.w,ink.y).x;
 return{box,measure:{left,right},obstacles:sceneObstacles(page,ops,stationary,sourceInk,pageBox),ownBand:true};
}

/** Painted coverage: every painted output box stays inside the envelope (and
 * any source clip), misses every other painted object, and changed blocks
 * do not overlap each other. Unknown ink never proves anything. */
export function retypesetEnvelopeClear(plan:Plan,envelope:RetypesetEnvelope,ink:Map<RetypesetCluster,Ink>,scopes:ReturnType<typeof retypesetScopes>){
 for(const [a,o]of ink){
  if(!o.known)return false;
  if(o.box.w<=0||o.box.h<=0)continue;
  if(!contains(envelope.box,o.box)||envelope.obstacles.some(b=>intersects(b,o.box)))return false;
  const clip=scopes.get(a.home.glyph.opIndex)?.clip;
  if(clip===null||clip&&!contains(clip,o.box))return false;
 }
 return !plan.blocks.some((b,j)=>plan.blocks.slice(j+1).some(next=>b.output.some(a=>ink.has(a)&&next.output.some(c=>ink.has(c)&&intersects(ink.get(a)!.box,ink.get(c)!.box)))));
}

/** Runs only on a row the existing pipeline left overlapping. Every attempt
 * starts from a snapshot; without a fit the clusters return to it exactly,
 * so the failure outcome is unchanged. */
export function fitRetypesetEnvelope(plan:Plan,envelope:RetypesetEnvelope,scopes:ReturnType<typeof retypesetScopes>,measure:(a:RetypesetCluster)=>Ink){
 const snapshot=plan.output.map(a=>({a,x:a.x,y:a.y,fit:a.fit,advance:a.advance}));
 const restore=()=>{for(const s of snapshot){s.a.x=s.x;s.a.y=s.y;s.a.fit=s.fit;s.a.advance=s.advance;}};
 const output=plan.output.filter(a=>!a.hard),line=plan.group.lines[0]!;
 for(const {step,adjustment}of retypesetEnvelopeLadder()){
  // In its own band a line has one row; leading rungs cannot change it.
  if(envelope.ownBand&&step==='leading')continue;
  let fit:Fit;
  try{fit=layoutRetypeset(plan,adjustment,envelope.measure);}catch{restore();continue;}
  // Own band: any re-break is a new row, whatever the box would admit.
  if(envelope.ownBand&&(plan.group.lines.length!==1||plan.output.some(a=>a.hard||a.y!==line.y)))continue;
  const ink=new Map(output.map(a=>[a,measure(a)] as const));
  // Leading below the size ratio narrows the gap between rows of one block
  // beyond anything the source shows, so those rows must not touch.
  const rowsClear=step!=='leading'||![...ink].some(([a,o],i)=>o.box.w>0&&o.box.h>0&&[...ink].slice(i+1).some(([c,q])=>Math.abs(c.y!-a.y!)>1e-6&&q.box.w>0&&q.box.h>0&&intersects(o.box,q.box)));
  if(rowsClear&&retypesetEnvelopeClear(plan,envelope,ink,scopes))return{fit,ink,restore,envelopeFit:{envelope:envelope.box,step,leadingScale:adjustment.leadingScale??adjustment.sizeScale,
   sizeScale:adjustment.sizeScale,trackingEm:adjustment.trackingEm,wordReductionEm:adjustment.wordReductionEm,floor:RETYPESET_ENVELOPE_FLOOR,...(envelope.ownBand?{basis:'own-band' as const}:{})}};
 }
 restore();
}
