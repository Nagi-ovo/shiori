import type {PDFPage} from 'pdf-lib';
import type {PdfRect} from '../../model/types';
import type {ContentOp} from '../contentStreamEdit/tokenizer';
import {pdfNumber} from '../contentStreamEdit/runEncoding';
import {address,type readRetypesetSource} from './retypesetSource';
import type {planRetypeset} from './retypesetPlan';
import type {layoutRetypeset} from './retypesetLayout';
import {retypesetScopes,retypesetPaintOps} from './retypesetScopes';
import {bounds} from './retypesetInk';
import {reflowScene} from './reflowScene';
import {contains,intersects} from './regionProof/geometry';
import type {RetypesetFrame} from './retypesetFrame';
import type {RetypesetPushSpace} from './retypesetForms';
import {emitRetypesetPushText} from './retypesetPushEmit';

type Plan=ReturnType<typeof planRetypeset>;
type Source=ReturnType<typeof readRetypesetSource>;
type Ink={box:PdfRect;known:boolean};
type Item={box:PdfRect;op:number;glyph?:Source['glyphs'][number];kind:string;known:boolean};
export type PushPatch={start:number;end:number;prefix:string;suffix:string};
/** Chain rules, used only for a row the push, frame and envelope paths left
 * overlapping. Emptiness is proved on painted coverage of the swept
 * destination minus the moving set: a box without area paints nothing, and a
 * glyph left unknown only for its matrix takes its transformed envelope. A
 * row or rule spanning the whole measure and more moves with the column only
 * when no foreign-column row shares its x-range near the move and it lies
 * outside the top and bottom tenth of the page (running heads and feet);
 * furniture and units offset into another region never move, and nothing
 * moves into the bottom tenth (page feet and numbers). The band
 * grows by source boxes, as an existing push does, unless `stopOnPainted`. */
export type RetypesetChainRules={painted:(g:Source['glyphs'][number])=>Ink|undefined;stopOnPainted:boolean};
/** This changes only approximate retypeset. Column edges come from the same
 * visual group as layout. Entire below-band items move, or none do. Geometry
 * checks cover both the swept region and every destination; a fixed obstacle
 * never becomes fabricated whitespace. */
export function planRetypesetPush(page:PDFPage,ops:ContentOp[],source:Source,plan:Plan,fit:ReturnType<typeof layoutRetypeset>,target:ReadonlySet<string>,
 outputInk:Ink[],sourceInk:Map<string,Ink>,blockReason?:string,fixedInk:Ink[]=[],internalOverlap=false,formSpace?:RetypesetPushSpace,boundedFrame?:RetypesetFrame,chain?:RetypesetChainRules){
 const media=page.getMediaBox(),crop=page.getCropBox(),pageBox={x:Math.max(media.x,crop.x),y:Math.max(media.y,crop.y),w:0,h:0};
 pageBox.w=Math.min(media.x+media.width,crop.x+crop.width)-pageBox.x;pageBox.h=Math.min(media.y+media.height,crop.y+crop.height)-pageBox.y;
 const items:Item[]=source.glyphs.filter(g=>!target.has(address(g.glyph))).map(g=>{
  const stored=sourceInk.get(address(g.glyph))!,ink=chain&&!stored.known?chain.painted(g)??stored:stored;
  return{box:ink.box,op:g.glyph.opIndex,glyph:g,kind:'text',known:ink.known};
 });
 for(const o of fixedInk)items.push({box:o.box,known:o.known,op:-1,kind:'annot'});
 const insideFrame=boundedFrame&&outputInk.every(o=>o.known&&contains(boundedFrame.box,o.box));
 reflowScene(page,ops,pageBox,(box,kind,op)=>{if(kind!=='backdrop'&&!(insideFrame&&boundedFrame!.paintOps.has(op)))items.push({box,kind,op,known:kind!=='unknown'});},.01);
 const newInk=outputInk.filter(o=>o.box.w>0&&o.box.h>0);
 const hit=(region:PdfRect,o:Item)=>(!chain||o.box.w>0&&o.box.h>0)&&intersects(region,o.box);
 const lands=(dest:PdfRect)=>(!chain||dest.w>0&&dest.h>0)&&newInk.some(n=>intersects(n.box,dest));
 const overlap=(except:Set<Item>)=>newInk.some(n=>items.some(o=>!except.has(o)&&hit(n.box,o)));
 // Band growth: source boxes, unless a chain asks for painted coverage.
 const painted=!!chain?.stopOnPainted,grow={hit:painted?hit:(r:PdfRect,o:Item)=>intersects(r,o.box),lands:painted?lands:(d:PdfRect)=>newInk.some(n=>intersects(n.box,d))};
 const growOverlap=(except:Set<Item>)=>newInk.some(n=>items.some(o=>!except.has(o)&&grow.hit(n.box,o)));
 const result={pushed:false,pushedDeltaPt:0,pushReason:undefined as string|undefined,overflowInkOverlap:internalOverlap||overlap(new Set()),glyphDeltas:new Map<string,number>(),paintDeltas:new Map<number,number>(),regions:[] as {before:PdfRect;after:PdfRect}[],patches:[] as PushPatch[]};
 if(internalOverlap)return{...result,pushReason:'push-blocked-by-multiple-changed-blocks'};
 if(boundedFrame)return{...result,pushReason:!insideFrame||result.overflowInkOverlap?'push-blocked-by-bounded-frame':undefined};
 if(fit.addedHeight<=.01)return result;
 // Reserve the wrapped row's whole observed column band. A short last CJK
 // glyph and a right-aligned subtitle may not touch in x, yet must not share
 // a baseline/ink band after wrapping.
 const edge0=plan.frame.global(plan.group.left,0),edge1=plan.frame.global(plan.group.right,0);
 const wrapBandOverlap=newInk.some(n=>items.some(o=>o.box.x<edge1.x&&o.box.x+o.box.w>edge0.x&&
  o.box.y<n.box.y+n.box.h&&o.box.y+o.box.h>n.box.y));
 if(!wrapBandOverlap&&!result.overflowInkOverlap)return result;
 const blocked=(reason:string)=>({...result,pushReason:`push-blocked-by-${reason}`});
 if(blockReason)return blocked(blockReason);
 if(!source.walk.ok||source.walk.unplacedText)return blocked('unplaced-text');
 if(outputInk.some(o=>!o.known))return blocked('unknown-output-ink');
 const p0=plan.frame.global(plan.group.left,0),p1=plan.frame.global(plan.group.right,0),down=plan.frame.global(0,-fit.addedHeight);
 if(Math.abs(p0.y)>1e-8||Math.abs(p1.y)>1e-8||Math.abs(down.x)>1e-8||down.y>=0)return blocked('nonhorizontal-frame');
 const delta=-down.y,left=p0.x,right=p1.x,threshold=Math.max(...plan.tail.map(g=>g.glyph.coreQuad[0].y));
 const contexts=retypesetScopes(ops,formSpace?.box);
 const inBand=(b:PdfRect)=>b.x>=left-.5&&b.x+b.w<=right+.5;
 const below=(o:Item)=>o.glyph?o.glyph.y<threshold-.05:o.box.y+o.box.h<=threshold+.01;
 // Classify complete visual rows, split at observed inter-column gaps.
 // A full-width author/footer line is a barrier, never a bag of individual
 // glyphs from which a partial in-column suffix may be selected.
 const rows:Item[][]=[];
 for(const o of items.filter(o=>o.glyph).sort((a,b)=>b.glyph!.y-a.glyph!.y||a.glyph!.x-b.glyph!.x)){
  const row=rows.findLast(r=>Math.abs(r[0]!.glyph!.y-o.glyph!.y)<.05&&
   o.glyph!.x-(r.at(-1)!.glyph!.glyph.coreQuad[1].x)<2*Math.max(o.glyph!.state.fontSize,r.at(-1)!.glyph!.state.fontSize));
  if(row)row.push(o);else rows.push([o]);
 }
 const units=rows.map(row=>({members:row,columnBox:bounds(row.flatMap(o=>o.glyph!.glyph.coreQuad)),box:bounds(row.flatMap(o=>[
  {x:o.box.x,y:o.box.y},{x:o.box.x+o.box.w,y:o.box.y+o.box.h}]))}));
 for(const o of items.filter(o=>!o.glyph))units.push({members:[o],box:o.box,columnBox:o.box});
 // An em or one eighth of the observed measure (whichever is smaller)
 // admits rule endcaps / small indents, not another column. A wider unit
 // needs most of its width and its centre in this column, and cannot cross
 // x occupied by a complete foreign row. Page-margin furniture stays fixed.
 const pitch=plan.frame.global(0,plan.group.pitch).y,em=Math.abs(plan.frame.global(plan.tail[0]!.state.fontSize,0).x);
 const outset=Math.min(em,(right-left)/8),margin=Math.min(pitch,media.height/10);
 const foreign=units.filter(u=>u.members.some(o=>o.glyph)&&(u.columnBox.x>=right+.5||u.columnBox.x+u.columnBox.w<=left-.5));
 const furniture=(u:typeof units[number])=>u.box.y<media.y+margin||u.box.y+u.box.h>media.y+media.height-margin||
  u.columnBox.w>=media.width-2*margin;
 const columnMember=(u:typeof units[number])=>{
  const b=u.columnBox;
  if(furniture(u))return false;
  if(inBand(b))return true;
  if(chain&&b.x<=left+outset&&b.x+b.w>=right-outset&&u.members.every(below)&&u.box.y>=media.y+media.height/10&&u.box.y+u.box.h<=media.y+media.height*.9)return!foreign.some(f=>b.x<f.columnBox.x+f.columnBox.w&&b.x+b.w>f.columnBox.x&&
   f.box.y<threshold&&f.box.y+f.box.h>u.box.y-delta);
  return b.x>=left-outset&&b.x+b.w<=right+outset&&b.x+b.w/2>=left&&b.x+b.w/2<=right&&
   Math.min(right,b.x+b.w)-Math.max(left,b.x)>=b.w/2&&
   !foreign.some(f=>b.x<f.columnBox.x+f.columnBox.w&&b.x+b.w>f.columnBox.x);
 };
 const crosses=(u:typeof units[number])=>u.columnBox.x<right&&u.columnBox.x+u.columnBox.w>left&&!columnMember(u);
 const barrier=Math.max(-Infinity,...units.filter(u=>u.members.every(below)&&
  (crosses(u)||u.columnBox.x<right&&u.columnBox.x+u.columnBox.w>left&&u.members.some(o=>['annot','unknown'].includes(o.kind)))).map(u=>u.box.y+u.box.h));
 const eligible=units.filter(u=>columnMember(u)&&u.box.y>=barrier&&u.members.every(o=>below(o)&&!['annot','unknown'].includes(o.kind)))
  .sort((a,b)=>b.box.y+b.box.h-a.box.y-a.box.h);
 // Column evidence is local. A gap exceeding four observed pitches ends
 // this band rather than recruiting a distant page footer into the push.
 let last=threshold;
 const moving=new Set<Item>();
 for(const u of eligible){
  if(last-(u.box.y+u.box.h)>4*pitch)break;
  u.members.forEach(o=>moving.add(o));last=Math.min(last,u.box.y);
  // Stop at an actual gap that absorbs Δ. Recruiting the rest of the page
  // would drag a footer/body across whitespace even though the affected
  // complete rows/graphics already have clear destinations. The four-pitch
  // rule remains the outer locality limit, including for very large edits.
  if(!growOverlap(moving)&&[...moving].every(o=>{
   const dest={...o.box,y:o.box.y-delta},swept={...dest,h:dest.h+delta};
   return contains(pageBox,dest)&&!items.some(f=>!moving.has(f)&&grow.hit(swept,f))&&!grow.lands(dest);
  }))break;
 }
 if(!moving.size)return blocked('foreign-column-or-obstacle');
 if([...moving].some(o=>!o.known))return blocked('unknown-source-ink');
 if(overlap(moving))return blocked('unpushable-ink');
 // A line/show can span columns. Moving only some of its glyphs would alter
 // its intra-run spacing or drag outsiders: reject before changing bytes.
 const movingOps=new Set([...moving].filter(o=>o.glyph).map(o=>o.op));
 for(const g of source.glyphs)if(movingOps.has(g.glyph.opIndex)&&(!moving.has(items.find(o=>o.glyph===g)!)||target.has(address(g.glyph))))return blocked('shared-show');
 for(const o of moving){
  const dest={...o.box,y:o.box.y-delta},swept={...dest,h:dest.h+delta};
  if(!contains(pageBox,dest))return blocked(formSpace?'form-bbox':'crop-media-box');
  if(chain&&dest.y<media.y+media.height/10)return blocked('page-foot');
  const boundReason=formSpace?.blocked(swept);if(boundReason)return blocked(boundReason);
  const clip=contexts.get(o.op)?.clip;
  if(formSpace&&(clip===null||clip&&!contains(clip,swept)))return blocked('form-clip');
  if(items.some(f=>!moving.has(f)&&hit(swept,f)))return blocked('fixed-or-foreign-obstacle');
  if(lands(dest))return blocked('destination-overlap');
 }
 // Recover graphics construction spans and their CTMs. A clipped text show
 // can move only when its complete old and translated ink fit the same clip.
 // Scene paint bounds are already clipped, so they cannot prove that a
 // clipped graphic has no hidden paint to expose: keep those moves blocked.
 const patches:PushPatch[]=[];
 for(const opIndex of new Set([...moving].map(o=>o.op))){
  const op=ops[opIndex],context=contexts.get(opIndex);
  if(!op||!context)return blocked('missing-source-scope');
  if(context.clip===null)return blocked('unknown-clip');
  const isText=movingOps.has(opIndex),start=isText?opIndex:context.start;
  // A Form BBox supplied as the initial clip is already the form-local page
  // box; it is not a content-stream clip that would hide paint. Tighter or
  // page-level clips still require a complete source/destination proof.
  const formBound=formSpace&&context.clip&&Math.abs(context.clip.x-formSpace.box.x)<1e-6&&Math.abs(context.clip.y-formSpace.box.y)<1e-6&&
   Math.abs(context.clip.w-formSpace.box.w)<1e-6&&Math.abs(context.clip.h-formSpace.box.h)<1e-6;
  if(context.clip&&!formBound){
   if(!isText)return blocked('clipped-graphics');
   const members=[...moving].filter(o=>o.op===opIndex);
   if(members.some(o=>!contains(context.clip!,o.box)))return blocked('source-ink-outside-clip');
   if(members.some(o=>!contains(context.clip!,{...o.box,y:o.box.y-delta})))return blocked('destination-outside-clip');
  }
  if(!isText&&(!context.clean||!['Do','BI',...retypesetPaintOps].includes(op.operator)))return blocked('graphics-scope');
  const c=context.ct,det=c[0]!*c[3]!-c[1]!*c[2]!;
  if(!Number.isFinite(det)||Math.abs(det)<1e-10)return blocked('singular-ctm');
  // Invert the page-space (0,-Δ) vector into the current CTM's user space.
  const tx=c[2]!*delta/det,ty=-c[0]!*delta/det;
  // Graphics keep their complete construction span and saved page-space clip.
  // Text stays in its original BT/ET and never changes CTM.
  const emission=isText?emitRetypesetPushText(source.glyphs.find(g=>g.glyph.opIndex===opIndex)!.state,op,source.ends.get(opIndex)!,delta):
   {prefix:` q 1 0 0 1 ${pdfNumber(tx)} ${pdfNumber(ty)} cm `,suffix:' Q '};
  patches.push({start:ops[start]!.start,end:op.end,...emission});
 }
 if(patches.some((p,i)=>patches.slice(i+1).some(q=>p.start<q.end&&q.start<p.end)))return blocked('interleaved-graphics');
 for(const o of moving)if(o.glyph)result.glyphDeltas.set(address(o.glyph.glyph),delta);else result.paintDeltas.set(o.op,delta);
 return{...result,pushed:true,pushedDeltaPt:delta,overflowInkOverlap:false,patches,regions:units.filter(u=>u.members.every(o=>moving.has(o))).map(u=>({before:u.box,after:{...u.box,y:u.box.y-delta}}))};
}

/** Rewalk compiled graphics as a multiset of conservative paint bounds. This
 * complements the writer's glyph proof: each moved object shares Δ and every
 * unpushed object retains its envelope. No raster authorizes a destination. */
export function verifyRetypesetPushPaint(page:PDFPage,before:ContentOp[],after:ContentOp[],deltas:Map<number,number>){
 if(!deltas.size)return;
 const m=page.getMediaBox(),media={x:m.x,y:m.y,w:m.width,h:m.height};
 const signature=(box:PdfRect,kind:string)=>JSON.stringify([kind,...[box.x,box.y,box.w,box.h].map(v=>Math.round(v*1e5))]);
 const actual=new Map<string,number>();
 reflowScene(page,after,media,(box,kind)=>{const k=signature(box,kind);actual.set(k,(actual.get(k)??0)+1);},.01);
 reflowScene(page,before,media,(box,kind,op)=>{
  const k=signature({...box,y:box.y-(deltas.get(op)??0)},kind),count=actual.get(k)??0;
  if(!count)throw Error('compiled push changed an unpushed graphic or applied a different delta');
  actual.set(k,count-1);
 },.01);
 if([...actual.values()].some(n=>n!==0))throw Error('compiled push introduced unexplained page paint');
}
