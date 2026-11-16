import type {PDFPage} from 'pdf-lib';
import type {PdfRect} from '../../model/types';
import type {ContentOp} from '../contentStreamEdit/tokenizer';
import type {planRetypeset} from './retypesetPlan';
import {bounds} from './retypesetInk';
import {retypesetScopes} from './retypesetScopes';
import {strokeEnvelopes} from './regionProof/strokeOccupancy';
import {contains,intersects,intersectRect} from './regionProof/geometry';

type Segment={box:PdfRect;op:number;guard:number};
export type RetypesetFrame={box:PdfRect;paintOps:Set<number>;kind:'cell'|'box'|'background'};
/** Frames require closed, axis-aligned geometry, never the bbox of an arbitrary
 * path. All four cell sides must actually meet. No tagged-PDF dependency. */
export function detectRetypesetFrame(page:PDFPage,ops:ContentOp[],plan:ReturnType<typeof planRetypeset>):RetypesetFrame|undefined{
 const p0=plan.frame.global(1,0),p1=plan.frame.global(0,1);
 if(p0.x<=0||p1.y<=0||Math.abs(p0.y)>1e-8||Math.abs(p1.x)>1e-8)return;
 const source=bounds(plan.tail.flatMap(g=>g.glyph.coreQuad)),scopes=retypesetScopes(ops),strokes=strokeEnvelopes(page,ops);
 const horizontal:Segment[]=[],vertical:Segment[]=[],candidates:RetypesetFrame[]=[],all:Segment[]=[],backgrounds:{box:PdfRect;op:number}[]=[];
 const firstShow=Math.min(...plan.tail.map(g=>g.glyph.opIndex)),crop=page.getCropBox();
 const media=page.getMediaBox(),pageBounds=intersectRect({x:crop.x,y:crop.y,w:crop.width,h:crop.height},{x:media.x,y:media.y,w:media.width,h:media.height});
 if(!pageBounds)return;
 const em=Math.abs(plan.frame.global(0,plan.tail[0]!.state.fontSize).y);
 const inset=(box:PdfRect,g:number):PdfRect=>({x:box.x+g,y:box.y+g,w:box.w-2*g,h:box.h-2*g});
 for(const [i,op]of ops.entries()){
  const stroke=['S','s','B','B*','b','b*'].includes(op.operator),fill=['f','F','f*','B','B*','b','b*'].includes(op.operator);
  if(!stroke&&!fill)continue;
  const scope=scopes.get(i);if(!scope?.clean||scope.start===i||scope.clip===null)continue;
  const ct=scope.ct;if(Math.abs(ct[1]!)>1e-8||Math.abs(ct[2]!)>1e-8)continue;
  const transform=(x:number,y:number)=>({x:ct[0]!*x+ct[4]!,y:ct[3]!*y+ct[5]!});
  const paths=ops.slice(scope.start,i),segments:Segment[]=[],rects:PdfRect[]=[];
  const envelope=strokes.get(i);if(stroke&&envelope===undefined)continue;
  const guard=stroke?envelope!*Math.hypot(...ct.slice(0,4))+.01:0;
  let at:{x:number;y:number}|undefined,start=at,valid=true;
  const line=(end:{x:number;y:number})=>{
   if(!at||Math.abs(at.x-end.x)>1e-7&&Math.abs(at.y-end.y)>1e-7){valid=false;return;}
   segments.push({box:bounds([at,end]),op:i,guard});at=end;
  };
  for(const path of paths){
   const n=path.operands.map(v=>v.kind==='number'?v.value:NaN);
   if(n.some(v=>!Number.isFinite(v))){valid=false;break;}
   if(path.operator==='m'&&n.length===2)at=start=transform(n[0]!,n[1]!);
   else if(path.operator==='l'&&n.length===2)line(transform(n[0]!,n[1]!));
   else if(path.operator==='h'&&start)line(start);
   else if(path.operator==='re'&&n.length===4){
    const ps=[[n[0]!,n[1]!],[n[0]!+n[2]!,n[1]!],[n[0]!+n[2]!,n[1]!+n[3]!],[n[0]!,n[1]!+n[3]!]].map(([x,y])=>transform(x!,y!));
    rects.push(bounds(ps));at=start=ps[0];for(const p of [...ps.slice(1),ps[0]!])line(p);
   }else{valid=false;break;}
  }
  if(!valid)continue;
  if(['s','b','b*'].includes(op.operator)&&start&&at&&(at.x!==start.x||at.y!==start.y))line(start);
  const singleRectangle=paths.length===1&&rects.length===1;
  if(scope.clip&&!singleRectangle&&segments.some(s=>!contains(scope.clip!,s.box)))continue;
  if(stroke){all.push(...segments);horizontal.push(...segments.filter(s=>s.box.h===0&&s.box.w>0));vertical.push(...segments.filter(s=>s.box.w===0&&s.box.h>0));}
  // Only a single rectangle proves a filled bounded background. Exclude
  // page-sized backdrops and paint emitted after the edited source.
  if(singleRectangle){
   const outer=rects[0]!,visible=intersectRect(outer,scope.clip?intersectRect(pageBounds,scope.clip)??{x:0,y:0,w:0,h:0}:pageBounds);
   if(!visible)continue;
   // Many PDF tables use thin filled rectangles instead of stroked lines.
   // Their centre segments and half-thickness envelopes form the same cell
   // geometry; a broad fill remains a background, never a rule.
   if(fill&&!stroke){
    let segment:Segment|undefined;
    if(visible.h<=em/8&&visible.w>=em)segment={box:{x:visible.x,y:visible.y+visible.h/2,w:visible.w,h:0},op:i,guard:visible.h/2+.01};
    else if(visible.w<=em/8&&visible.h>=em)segment={box:{x:visible.x+visible.w/2,y:visible.y,w:0,h:visible.h},op:i,guard:visible.w/2+.01};
    if(segment){all.push(segment);(segment.box.h===0?horizontal:vertical).push(segment);}
   }
   const box=intersectRect(inset(outer,guard),visible);if(!box)continue;
   if(fill&&i<firstShow&&contains(visible,source))backgrounds.push({box:visible,op:i});
   const pageOutline=visible.w>=crop.width-2*em&&visible.h>=crop.height-2*em;
   if(!pageOutline&&contains(box,source)&&(stroke||fill&&i<firstShow&&outer.h<crop.height/2))candidates.push({box,paintOps:new Set([i]),kind:stroke?'box':'background'});
  }
 }
 const above=horizontal.filter(s=>s.box.y>=source.y+source.h),below=horizontal.filter(s=>s.box.y<=source.y);
 const left=vertical.filter(s=>s.box.x<=source.x),right=vertical.filter(s=>s.box.x>=source.x+source.w);
 const covers=(lo:number,hi:number,a:number,b:number,guard:number)=>lo<=a+guard+1e-7&&hi>=b-guard-1e-7;
 for(const top of above)for(const bottom of below){
  const b=bottom.box.y,t=top.box.y;
  for(const l of left.filter(s=>covers(s.box.y,s.box.y+s.box.h,b,t,s.guard)))for(const r of right.filter(s=>covers(s.box.y,s.box.y+s.box.h,b,t,s.guard))){
   const x=l.box.x,end=r.box.x;
   if(![top,bottom].every(s=>covers(s.box.x,s.box.x+s.box.w,x,end,s.guard)))continue;
   if(end-x>=crop.width-2*em&&t-b>=crop.height-2*em)continue;
   const g=Math.max(top.guard,bottom.guard,l.guard,r.guard),box=intersectRect(inset({x,y:b,w:end-x,h:t-b},g),pageBounds);
   if(box&&contains(box,source))candidates.push({box,paintOps:new Set([top.op,bottom.op,l.op,r.op]),kind:'cell'});
  }
 }
 // A compound table path can own many rules. Ignoring its enclosing bbox is
 // safe only when none of its actual segments crosses the chosen interior.
 const chosen=candidates.filter(c=>!all.some(s=>c.paintOps.has(s.op)&&intersects(inset(c.box,1e-7),{x:s.box.x-s.guard,y:s.box.y-s.guard,w:s.box.w+2*s.guard,h:s.box.h+2*s.guard})))
  .sort((a,b)=>a.box.w*a.box.h-b.box.w*b.box.h)[0];
 if(chosen)for(const b of backgrounds)if(contains(b.box,chosen.box))chosen.paintOps.add(b.op);
 return chosen;
}
