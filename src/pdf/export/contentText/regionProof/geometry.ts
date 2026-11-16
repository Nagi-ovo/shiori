import type { ParagraphLine, Rect, TextTrace } from './types';

export const EPS = 1e-7;
export const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance + EPS;
export const finiteMatrix = (m: readonly number[]) => m.length === 6 && m.every(Number.isFinite);
export const coefficientEqual = (a: number, b: number) =>
  Math.abs(a - b) <= Math.max(1e-9, 1e-6 * Math.max(Math.abs(a), Math.abs(b)));
export const matrixEqual = (a: readonly number[], b: readonly number[]) =>
  // Full snapshot translations come from the same numeric source walk;
  // relative coefficient tolerance must never license coordinate drift.
  a.length === b.length && a.every((v, i) => i < 4 ? coefficientEqual(v, b[i]!) : v === b[i]);

export function linear(t: TextTrace): readonly number[] {
  const [a, b, c, d] = t.tm, [e, f, g, h] = t.ctm;
  return [a! * e! + b! * g!, a! * f! + b! * h!, c! * e! + d! * g!, c! * f! + d! * h!];
}
export function origin(t: TextTrace): readonly [number, number] {
  const x = t.tm[4]! + t.rise * t.tm[2]!, y = t.tm[5]! + t.rise * t.tm[3]!;
  return [x * t.ctm[0]! + y * t.ctm[2]! + t.ctm[4]!,
    x * t.ctm[1]! + y * t.ctm[3]! + t.ctm[5]!];
}
export const physicalSize = (t: TextTrace) => t.size * Math.hypot(linear(t)[2]!, linear(t)[3]!);
export const physicalLeading = (t: TextTrace) => t.leading * linear(t)[3]!;
export function validTrace(t: TextTrace): boolean {
  if (![t.ctm, t.tm, t.tlm].every(finiteMatrix) ||
    ![t.bt, t.opIndex, t.size, t.tc, t.tw, t.tz, t.leading, t.rise, t.renderMode].every(Number.isFinite)) return false;
  const [a, b, c, d] = linear(t);
  return a! > 0 && d! > 0 && Math.abs(b!) <= 1e-9 && Math.abs(c!) <= 1e-9 &&
    t.size > 0 && t.tz > 0 && t.leading >= 0 && Number.isInteger(t.bt) &&
    Number.isInteger(t.opIndex) && t.renderMode === 0 &&
    !!t.fontObject && !!t.safetyHash && t.scopeSafe!==false;
}
/** A positioning operation supplies geometry, not editable marked content.
 * EMC does not restore Tm/Tlm; shows still require validTrace(). */
export const validPositionAnchor=(t:TextTrace)=>validTrace({...t,scopeSafe:true});
export function lastPositionAnchor(anchors:readonly TextTrace[],show:TextTrace):TextTrace|undefined {
  const anchor=anchors.findLast(t=>t.opIndex<show.opIndex&&t.bt===show.bt);
  return anchor&&validPositionAnchor(anchor)?anchor:undefined;
}
export function compatible(t: TextTrace, base: TextTrace): boolean {
  return validTrace(t) && t.fontObject === base.fontObject &&
    (t.scopeKey??'[]')===(base.scopeKey??'[]') &&
    t.safetyHash === base.safetyHash && near(physicalSize(t), physicalSize(base), 0.05) &&
    linear(t).every((n, i) => coefficientEqual(n, linear(base)[i]!)) &&
    (['tc', 'tw', 'tz', 'rise', 'renderMode'] as const).every(key => t[key] === base[key]);
}
/** Paragraph membership permits measured face/justification changes. Keep
 * compatible() tight for callers that need an identical same-show state. */
export function paragraphMember(t: TextTrace, base: TextTrace): boolean {
  return validTrace(t) && validTrace(base) &&
    (t.scopeKey??'[]')===(base.scopeKey??'[]') &&
    paragraphGeometry(t,base);
}
function paragraphGeometry(t:TextTrace,base:TextTrace):boolean{
  return t.safetyHash===base.safetyHash && near(physicalSize(t), physicalSize(base), 0.05) &&
    linear(t).every((n, i) => coefficientEqual(n, linear(base)[i]!)) &&
    (['tz', 'rise', 'renderMode'] as const).every(key => t[key] === base[key]);
}
/** Compare positioning anchors without assigning their scope to a show.
 * Occupancy keeps the existing size/rise allowance for an unmoved prefix,
 * after validating the anchor's original numeric state. */
export function positionAnchorMember(anchor:TextTrace,base:TextTrace,perGlyph=false):boolean{
  return validPositionAnchor(anchor)&&validPositionAnchor(base)&&
    paragraphGeometry(perGlyph?{...anchor,size:base.size,rise:base.rise}:anchor,base);
}
/** Only size/rise may differ for an unmoved prefix. Scope, linear frame,
 * direction and render mode retain the paragraph membership requirements. */
export const paragraphFrame=(t:TextTrace,base:TextTrace)=>paragraphMember({...t,size:base.size,rise:base.rise},base);
export const lineStart=(line:ParagraphLine,perGlyph=false):readonly [number,number]=>{
 const t=line.shows[0]?.before??line.anchor,p=origin(t);
 return perGlyph?[p[0],line.baseline??origin(line.anchor)[1]]:p;
};
export const lineAnchors = (line: ParagraphLine): readonly TextTrace[] => [line.anchor, ...(line.continuations ?? [])];
export const anchorForShow = (line: ParagraphLine, op: number) => lineAnchors(line).findLast(t => t.opIndex < op);
export const validRect = (r: Rect) => [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w >= 0 && r.h >= 0;
export const contains = (outer: Rect, inner: Rect) => inner.x >= outer.x - EPS && inner.y >= outer.y - EPS &&
  inner.x + inner.w <= outer.x + outer.w + EPS && inner.y + inner.h <= outer.y + outer.h + EPS;
export const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w &&
  a.y < b.y + b.h && b.y < a.y + a.h;

export function intersectRect(a:Rect,b:Rect):Rect|null{
 const x=Math.max(a.x,b.x),y=Math.max(a.y,b.y),right=Math.min(a.x+a.w,b.x+b.w),top=Math.min(a.y+a.h,b.y+b.h);
 return right>x&&top>y?{x,y,w:right-x,h:top-y}:null;
}
/** Exact rectangle difference, without a tolerance that could erase a new
 * sliver of ink. Covers may overlap; their bounding union is insufficient. */
export function subtractRectangles(subject:Rect,covers:readonly Rect[]):Rect[]{
 let remaining=subject.w>0&&subject.h>0?[subject]:[];
 for(const cover of covers){
  remaining=remaining.flatMap(b=>{
   const cut=intersectRect(b,cover);if(!cut)return[b];
   return [
    {x:b.x,y:b.y,w:b.w,h:cut.y-b.y},
    {x:b.x,y:cut.y+cut.h,w:b.w,h:b.y+b.h-cut.y-cut.h},
    {x:b.x,y:cut.y,w:cut.x-b.x,h:cut.h},
    {x:cut.x+cut.w,y:cut.y,w:b.x+b.w-cut.x-cut.w,h:cut.h},
   ].filter(r=>r.w>0&&r.h>0);
  });
  if(!remaining.length)break;
 }
 return remaining;
}
