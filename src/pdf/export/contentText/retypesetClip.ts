import type {RetypesetCluster} from './retypesetTypes';
import type {planRetypeset} from './retypesetPlan';
import {layoutRetypeset} from './retypesetLayout';
import type {retypesetScopes} from './retypesetScopes';
import type {retypesetInk} from './retypesetInk';
import {contains} from './regionProof/geometry';

type Plan=ReturnType<typeof planRetypeset>;
type Ink=ReturnType<ReturnType<typeof retypesetInk>>;
/** Keep the original clip and anchor. A narrower line capacity may fit the
 * measured ink; insufficient height or unknown bounds still refuse. This is
 * approximate layout only, never permission to widen an inherited clip. */
export function layoutRetypesetInClip(plan:Plan,fit:ReturnType<typeof layoutRetypeset>,scopes:ReturnType<typeof retypesetScopes>,measure:(a:RetypesetCluster)=>Ink){
 const output=plan.output.filter(a=>!a.hard),inks=()=>new Map(output.map(a=>[a,measure(a)] as const));
 let ink=inks();
 if(fit.addedHeight<=.01)return{fit,ink};
 const refuse=(reason:string):never=>{throw Error(`retypeset-output-outside-source-clip: ${reason}`);};
 const clipped=output.filter(a=>{
  const scope=scopes.get(a.home.glyph.opIndex);
  if(!scope)return refuse('missing-source-scope');
  if(scope.clip===null)refuse('unknown-clip');
  if(scope.clip!==undefined&&!ink.get(a)!.known)refuse('unknown-output-ink');
  return scope.clip!==undefined;
 });
 const contained=()=>clipped.every(a=>contains(scopes.get(a.home.glyph.opIndex)!.clip!,ink.get(a)!.box));
 if(contained())return{fit,ink};
 const xAxis=plan.frame.global(1,0),yAxis=plan.frame.global(0,1);
 if(xAxis.x<=0||yAxis.y<=0||Math.abs(xAxis.y)>1e-8||Math.abs(yAxis.x)>1e-8)refuse('nonhorizontal-clip-layout');
 let left=plan.group.lines[1]?.x??plan.group.left,right=plan.group.right;
 for(const a of clipped){
  const clip=scopes.get(a.home.glyph.opIndex)!.clip!,box=ink.get(a)!.box,point=plan.frame.global(a.x!,a.y!);
  // Capacity is expressed in advances, while containment uses the actual
  // outline/stroke envelope. Do not substitute an em box for missing ink.
  left=Math.max(left,(clip.x-(box.x-point.x))/xAxis.x);
  right=Math.min(right,(clip.x+clip.w-(box.x+box.w-point.x))/xAxis.x+a.advance!);
 }
 if(!(right>left))refuse('insufficient-clip-width');
 const anchors=plan.blocks.map(b=>b.output.find(a=>!a.hard)).filter((a):a is RetypesetCluster=>!!a).map(a=>({a,x:a.x,y:a.y}));
 const adjustment=output.find(a=>a.fit)?.fit;fit=layoutRetypeset(plan,adjustment,{left,right});ink=inks();
 if(anchors.some(({a,x,y})=>a.x!==x||a.y!==y))refuse('clip-layout-would-move-anchor');
 if(!contained())refuse('insufficient-clip-space');
 return{fit,ink};
}
