import {PDFArray,PDFDict,PDFName,type PDFPage} from 'pdf-lib';
import {sourceFingerprint,type ResolvedRunFont} from '../../contentStreamEdit/replaceRun';
import type {ContentOp} from '../../contentStreamEdit/tokenizer';
import type {GlyphPlacement,UnplacedShow} from '../../contentStreamEdit/textState';
import {fontInputFromDict} from '../../fontCoverage/pdfLibAdapter';
import {isCffProgram} from '../../fontCoverage/cffHulls';
import {reflowScene,numericArray} from '../reflowScene';
import type {streamInkResolver,ReflowInk} from '../reflowInk';
import type {traceReflowSource} from '../reflowTrace';
import type {Rect,SourceAddress,TextTrace} from './types';
import {contains,intersects,linear,origin,validRect} from './geometry';
import {boundStrokedShow,strokeEnvelopes} from './strokeOccupancy';

export type GlyphKey=string;
export type OccupantKind='glyph'|'placement'|'paint'|'image'|'form'|'annot'|'unplaced'|'unknown'|'backdrop';
export type Occupant={id:number;kind:OccupantKind;box:Rect;owner?:GlyphKey;paintOp:number;measured:boolean};
export type PageOccupancy={
 items:Occupant[];grid:Map<number,number[]>;pageBlocked:boolean;hash:string;guardPt:number;
 glyphs:Map<GlyphKey,{ink?:ReflowInk;placement:Rect}>;embeddedFonts:Set<string>;
};
export const glyphKey=(s:SourceAddress):GlyphKey=>`${s.opIndex}:${s.itemIndex}:${s.byteStart}`;
export const placedGlyphKey=(g:GlyphPlacement):GlyphKey=>`${g.opIndex}:${g.arrayItemIndex}:${g.byteOffset}`;
/** 0.5 pt geometric guard plus one device pixel at the native oracle's dpi. */
export const inkGuardPt=(dpi=144)=>.5+72/dpi;
export const dilateInk=(b:Rect,g:number):Rect=>({x:b.x-g,y:b.y-g,w:b.w+2*g,h:b.h+2*g});
export const atOrigin=(b:Rect,x:number,y:number):Rect=>({...b,x:b.x+x,y:b.y+y});
export function boundBoxes(boxes:readonly Rect[]):Rect{
 const x=Math.min(...boxes.map(b=>b.x)),y=Math.min(...boxes.map(b=>b.y));
 return {x,y,w:Math.max(...boxes.map(b=>b.x+b.w))-x,h:Math.max(...boxes.map(b=>b.y+b.h))-y};
}
/** Placement is extraction geometry only, with the font's declared vertical
 * metrics and complete advance (including Tc/Tw). It never grants ink. */
export function placementBox(font:ResolvedRunFont,t:TextTrace,code:number,x:number,y:number):Rect{
 const [a,b,c,d]=linear(t),advance=(font.widthOf(code)*t.size/1000+t.tc+(font.bytesPerCode===1&&code===32?t.tw:0))*t.tz/100;
 const points=[0,advance].flatMap(dx=>[font.descentEm*t.size,font.ascentEm*t.size].map(dy=>({x:x+a!*dx+c!*dy,y:y+b!*dx+d!*dy,w:0,h:0})));
 return boundBoxes(points);
}
// 8 pt buckets. Oversized/outlandish bounds go in a global bucket instead
// of allocating an unbounded grid; queries still check their exact rectangle.
function cells(b:Rect):number[]|null{
 const x0=Math.floor(b.x/8),x1=Math.floor((b.x+b.w)/8),y0=Math.floor(b.y/8),y1=Math.floor((b.y+b.h)/8);
 if(!validRect(b)||[x0,x1,y0,y1].some(v=>Math.abs(v)>=2**24)||(x1-x0+1)*(y1-y0+1)>65536)return null;
 const result:number[]=[];for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)result.push(y*2**26+x);return result;
}
export function queryOccupancy(index:PageOccupancy,box:Rect):Occupant[]{
 const buckets=cells(box);
 if(!buckets)return index.items.filter(o=>o.kind!=='backdrop'&&intersects(o.box,box));
 const ids=new Set([...(index.grid.get(Infinity)??[]),...buckets.flatMap(k=>index.grid.get(k)??[])]);
 return [...ids].map(id=>index.items[id]!).filter(o=>intersects(o.box,box));
}
/** Shared production/classifier authority: no raster enters this builder. */
export function buildPageOccupancy(input:{page:PDFPage;ops:readonly ContentOp[];fonts:readonly ResolvedRunFont[];
 trace:ReturnType<typeof traceReflowSource>;glyphs:readonly GlyphPlacement[];unplaced:readonly UnplacedShow[];
 ink:ReturnType<typeof streamInkResolver>;sourceHash:string;dependencyHash:string;media:Rect}):PageOccupancy{
 const {page,ops,fonts,trace,glyphs,unplaced,ink,sourceHash,dependencyHash,media}=input,guardPt=inkGuardPt();
 const items:Occupant[]=[],grid=new Map<number,number[]>(),measures:PageOccupancy['glyphs']=new Map(),embeddedFonts=new Set<string>();
 const add=(kind:OccupantKind,box:Rect,paintOp:number,measured=false,owner?:GlyphKey)=>{
  items.push({id:items.length,kind,box:validRect(box)?box:media,paintOp,measured,...(owner?{owner}:{})});
 };
 reflowScene(page,ops,media,(box,kind,op)=>add(kind,box,op),guardPt);
 const declaredBoxes=new Map<string,number[]|undefined>(),byName=new Map(fonts.map(f=>[f.resourceName,f]));
 const resources=page.node.Resources()?.lookupMaybe(PDFName.of('Font'),PDFDict);
 // Unresolved fonts still need declared bounds for their unplaced shows.
 for(const name of resources?.keys()??[]){
  const raw=resources!.lookupMaybe(name,PDFDict),resourceName=name.decodeText(),font=byName.get(resourceName);
  if(!raw)continue;
  const child=raw.lookupMaybe(PDFName.of('DescendantFonts'),PDFArray)?.lookup(0,PDFDict),descriptor=(child??raw).lookupMaybe(PDFName.of('FontDescriptor'),PDFDict);
  const input=fontInputFromDict(raw),matrix=numericArray(raw,'FontMatrix');
  if(font&&(input.program||input.subtype==='Type3'))embeddedFonts.add(font.objectId);
  // Keep Round 4 refusals: no raw /1000 CFF bound, unknown FontFile3
  // transform, non-default Type1 matrix or degenerate declared envelope.
  if(matrix&&(matrix.length!==6||matrix.some((n,i)=>n!==[.001,0,0,.001,0,0][i]))||descriptor?.has(PDFName.of('FontFile3'))||input.program&&isCffProgram(input.program))continue;
  const b=numericArray(raw,'FontBBox')??(descriptor?numericArray(descriptor,'FontBBox'):undefined);
  if(b?.length===4&&b.every(Number.isFinite)&&b[2]!>b[0]!&&b[3]!>b[1]!)declaredBoxes.set(resourceName,b);
 }
 const strokes=strokeEnvelopes(page,ops);
 for(const s of unplaced){
  const t=trace.shows.get(`${s.opIndex}:${s.arrayItemIndex}`)?.before,b=s.fontName?declaredBoxes.get(s.fontName):undefined;
  if(t&&s.reason){
   const boxes=boundStrokedShow(s,t,ink,b,strokes.get(s.opIndex),media,guardPt);
   if(boxes){for(const box of boxes)add('unplaced',box,s.opIndex);continue;}
  }
  const o=s.origin??(t?{x:origin({...t,tm:t.tlm})[0],y:origin({...t,tm:t.tlm})[1]}:undefined);
  if(o&&t&&b&&s.reason===undefined&&Number.isFinite(o.y)&&Math.abs(linear(t)[1]!)<1e-9&&Math.abs(linear(t)[2]!)<1e-9){
   const y1=o.y+b[1]!*s.fontSizePt/1000,y2=o.y+b[3]!*s.fontSizePt/1000;
   add('unplaced',{x:media.x,y:Math.min(y1,y2)-guardPt,w:media.w,h:Math.abs(y2-y1)+2*guardPt},s.opIndex);
  }else add('unplaced',media,s.opIndex);
 }
 for(const g of glyphs){
  const t=trace.shows.get(`${g.opIndex}:${g.arrayItemIndex}`)?.before,font=byName.get(g.fontName),owner=placedGlyphKey(g),o=g.coreQuad[0];
  if(!t||!font){add('unknown',media,g.opIndex);continue;}
  const measured=ink(g.fontName,g.code,t),placement=placementBox(font,t,g.code,o.x,o.y);
  measures.set(owner,{ink:measured,placement});add('placement',placement,g.opIndex,!!measured,owner);
  if(measured){
   // A measured empty outline (space) paints nothing. Its placement above
   // still protects extraction; dilating an empty outline would invent ink.
   if(measured.box.w>0&&measured.box.h>0)add('glyph',dilateInk(atOrigin(measured.box,o.x,o.y),guardPt),g.opIndex,true,owner);
  }else{
   const bounds=declaredBoxes.get(g.fontName),[a,b,c,d]=linear(t);
   if(bounds){
    const points=[[bounds[0]!,bounds[1]!],[bounds[2]!,bounds[1]!],[bounds[2]!,bounds[3]!],[bounds[0]!,bounds[3]!]].map(([x,y])=>({
     x:o.x+(a!*x!*t.tz/100+c!*y!)*t.size/1000,y:o.y+(b!*x!*t.tz/100+d!*y!)*t.size/1000,w:0,h:0}));
    add('glyph',dilateInk(boundBoxes(points),guardPt),g.opIndex,false,owner);
   }else add('unknown',media,g.opIndex,false,owner);
  }
 }
 for(const o of items){
  if(o.kind==='backdrop')continue;
  for(const key of contains(o.box,media)?[Infinity]:cells(o.box)??[Infinity]){const bucket=grid.get(key)??[];bucket.push(o.id);grid.set(key,bucket);}
 }
 const hash=sourceFingerprint(new TextEncoder().encode(JSON.stringify({sourceHash,dependencyHash,guardPt,items})));
 return {items,grid,pageBlocked:items.some(o=>o.kind!=='backdrop'&&contains(o.box,media)),hash,guardPt,glyphs:measures,embeddedFonts};
}
