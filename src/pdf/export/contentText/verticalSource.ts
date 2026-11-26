import {PDFPage} from 'pdf-lib';
import {resolveRunFonts,runPageEnvironment} from '../contentStreamEdit/replaceRunPage';
import {walkTextPlacements,type GlyphPlacement,type ShowTextState} from '../contentStreamEdit/textState';
import type {ContentOp} from '../contentStreamEdit/tokenizer';
import {verticalPageFonts,type VerticalFont} from './verticalFont';
import {verticalRetypesetFonts} from './retypesetWritingMode';
import {bounds} from './retypesetInk';
import {retypesetInk} from './retypesetInk';
import type {PdfRect} from '../../model/types';

export type VerticalGlyph={glyph:GlyphPlacement;state:ShowTextState;font:VerticalFont;text:string|undefined;box:PdfRect|undefined};
export const verticalAddress=(g:GlyphPlacement)=>`${g.opIndex}:${g.arrayItemIndex}:${g.byteOffset}`;
export function verticalGlyphInk(font:VerticalFont,code:number,s:ShowTextState,pen:{x:number;y:number}){
 const box=font.ink(code);if(!box)return;
 const metric=font.vertical(code),tm=s.textMatrix!,ct=s.ctm!,size=s.fontSize,tz=s.horizontalScale!;
 const a=tm[0]!*ct[0]!+tm[1]!*ct[2]!,b=tm[0]!*ct[1]!+tm[1]!*ct[3]!,c=tm[2]!*ct[0]!+tm[3]!*ct[2]!,d=tm[2]!*ct[1]!+tm[3]!*ct[3]!;
 const ps=[{x:box.x,y:box.y},{x:box.x+box.w,y:box.y},{x:box.x+box.w,y:box.y+box.h},{x:box.x,y:box.y+box.h}].map(p=>{
  const x=(p.x-metric.vx/1000)*size*tz,y=(p.y-metric.vy/1000)*size;
  return {x:pen.x+a*x+c*y,y:pen.y+b*x+d*y};
 });
 const ink=bounds(ps),guard=.02;return{x:ink.x-guard,y:ink.y-guard,w:ink.w+2*guard,h:ink.h+2*guard};
}
export function readVerticalSource(page:PDFPage,ops:ContentOp[],vertical=verticalPageFonts(page)){
 const {fonts,failures}=vertical,horizontal=resolveRunFonts(page),environment=runPageEnvironment(page);
 const programModes=verticalRetypesetFonts(page);
 const states=new Map<string,ShowTextState>(),ends=new Map<number,{textMatrix:readonly number[];lineMatrix:readonly number[]}>(),unplaced:string[]=[];
 const resolveFont=(name:string)=>{
  if(programModes.has(name)&&!fonts.has(name))return{ok:false as const,reason:failures.get(name)??'Type1 WMode 1 has no CID vertical metrics proof'};
  const f=fonts.get(name)??horizontal.find(f=>f.resourceName===name);
  return f?{...f,ok:true as const,appliesWordSpacing:f.bytesPerCode===1}:{ok:false as const,reason:failures.get(name)??'unproved source font'};
 };
 const walk=walkTextPlacements(ops,{resolveFont,onShow:s=>states.set(`${s.opIndex}:${s.arrayItemIndex}`,s),onTextOpEnd:(op,m)=>ends.set(op,m),onUnplaced:s=>unplaced.push(s.reason??failures.get(s.fontName??'')??'unplaced source text'),extGStateSetsFont:name=>environment.extGStates?.get(name)?.setsFont??null});
 const glyphs:VerticalGlyph[]=walk.ok?walk.glyphs.flatMap(g=>{
  const font=fonts.get(g.fontName);if(!font)return[];
  const state=states.get(`${g.opIndex}:${g.arrayItemIndex}`)!;
  return[{glyph:g,state,font,text:font.labels.get(g.code.toString(16).padStart(4,'0')),box:verticalGlyphInk(font,g.code,state,g.pen!)}];
 }):[];
 const hInk=retypesetInk(page,horizontal,ops);
 const horizontalInk=walk.ok?walk.glyphs.filter(g=>!g.pen).map(g=>{
  const font=horizontal.find(f=>f.resourceName===g.fontName)!,state=states.get(`${g.opIndex}:${g.arrayItemIndex}`)!;
  return hInk(font,g.code,state,g.coreQuad[0].x,g.coreQuad[0].y);
 }):[];
 return{fonts,failures,horizontal,walk,glyphs,horizontalInk,states,ends,unplaced,resolveFont,environment};
}
