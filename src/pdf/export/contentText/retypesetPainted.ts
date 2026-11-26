import type {PdfRect} from '../../model/types';
import {address,type readRetypesetSource} from './retypesetSource';
import {sameRetypesetPush} from './retypesetChain';
import type {planRetypesetPush,RetypesetChainRules} from './retypesetPush';

type Push=ReturnType<typeof planRetypesetPush>;
type Ink={box:PdfRect;known:boolean};
type Source=ReturnType<typeof readRetypesetSource>;
export type RetypesetPaintedObservation={row:number;strategy:'push'|'chain-push'|'tighten-frame'|'fit-envelope'|'none';
 /** Stationary glyphs whose stored unknown box painted coverage replaced. */
 changed:number;existing:Push;painted:Push;same:boolean;flagged:boolean;paintedClear:boolean};
/** Shadow observer (r32 P2-B). When set, every row's final push is re-planned
 * on painted source ink and reported; output still comes from the stored
 * ink. Probes and tests set it; production leaves it unset. */
export const retypesetPaintedShadow:{observe?:(o:RetypesetPaintedObservation)=>void}={};

/** Source ink in which each stationary glyph that `retypesetInk` left
 * unknown takes its painted envelope (the transformed outline, declared or
 * Standard 14 box). A glyph without such an envelope keeps its stored
 * unknown box; edited glyphs and known glyphs are never touched. */
export function retypesetPaintedSourceInk(source:Source,target:ReadonlySet<string>,sourceInk:Map<string,Ink>,painted:RetypesetChainRules['painted']){
 const ink=new Map(sourceInk);let changed=0;
 for(const g of source.glyphs){
  const key=address(g.glyph),stored=sourceInk.get(key);
  if(target.has(key)||!stored||stored.known)continue;
  const p=painted(g);if(p){ink.set(key,p);changed++;}
 }
 return{ink,changed};
}

/** Same plan in every field a row reports: moved set, delta, patches,
 * regions, overlap flag and reason. */
export const samePaintedPush=(a:Push,b:Push)=>sameRetypesetPush(a,b)&&a.overflowInkOverlap===b.overflowInkOverlap&&a.pushReason===b.pushReason;

export function observeRetypesetPainted(rows:{push:Push;strategy:RetypesetPaintedObservation['strategy']}[],changed:number,replan:(i:number)=>Push,observe:NonNullable<typeof retypesetPaintedShadow.observe>){
 rows.forEach(({push,strategy},row)=>{
  const painted=replan(row);
  observe({row,strategy,changed,existing:push,painted,same:samePaintedPush(push,painted),
   flagged:!push.pushed&&push.overflowInkOverlap,paintedClear:!painted.pushed&&!painted.overflowInkOverlap});
 });
}

/** Live use (r32 P2-B), enabled after the shadow held. Only a row every
 * existing path (push, frame, envelope, chain, own band) left overlapping is
 * revisited, and only on a page where painted coverage replaced a box. */
export const retypesetPaintedLive={enabled:true};
/** Such a row takes the painted first push only if it moves nothing and is
 * clear. A painted plan that would move ink is not adopted, and unknown
 * output ink never proves a clear row. */
export const retypesetPaintedClears=(painted:Push,output:Iterable<Ink>)=>!painted.pushed&&!painted.overflowInkOverlap&&[...output].every(o=>o.known);
