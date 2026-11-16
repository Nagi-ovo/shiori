import {PDFDict,PDFName,type PDFPage} from 'pdf-lib';
import {Font as StandardFont,FontNames} from '@pdf-lib/standard-fonts';
import type {ResolvedRunFont} from '../contentStreamEdit/replaceRun';
import type {ShowTextState} from '../contentStreamEdit/textState';
import type {PdfRect} from '../../model/types';
import {streamInkResolver} from './reflowInk';
import {strokeEnvelopes} from './regionProof/strokeOccupancy';
import type {ContentOp} from '../contentStreamEdit/tokenizer';

export const bounds=(ps:readonly {x:number;y:number}[]):PdfRect=>{
 const x=Math.min(...ps.map(p=>p.x)),y=Math.min(...ps.map(p=>p.y));
 return{x,y,w:Math.max(...ps.map(p=>p.x))-x,h:Math.max(...ps.map(p=>p.y))-y};
};
/** Approximate-tier occupancy uses outline/declared bounds, never a coreQuad
 * as proof of empty ink. Standard 14 fonts have published AFM envelopes. */
export function retypesetInk(page:PDFPage,fonts:ResolvedRunFont[],ops:ContentOp[]){
 const resolver=streamInkResolver(page,fonts),strokes=strokeEnvelopes(page,ops);
 return(font:ResolvedRunFont,code:number,s:ShowTextState,x:number,y:number)=>{
  if(s.renderMode===3)return {box:{x,y,w:0,h:0},known:true};
  const tm=s.textMatrix!,ct=s.ctm!;
  const linear=[tm[0]!*ct[0]!+tm[1]!*ct[2]!,tm[0]!*ct[1]!+tm[1]!*ct[3]!,tm[2]!*ct[0]!+tm[3]!*ct[2]!,tm[2]!*ct[1]!+tm[3]!*ct[3]!];
  const horizontal=Math.abs(linear[1]!)<1e-8&&Math.abs(linear[2]!)<1e-8&&linear[0]!>0&&linear[3]!>0;
  const measured=horizontal?resolver(font.resourceName,code,{bt:0,opIndex:s.opIndex,ctm:ct,tm,tlm:s.lineMatrix!,fontObject:font.objectId,size:s.fontSize,tc:s.charSpacing,tw:s.wordSpacing,tz:s.horizontalScale!*100,leading:s.leading!,rise:s.rise!,renderMode:0,safetyHash:'approximate',scopeSafe:true}):undefined;
  let box=measured?.box;
  if(!box&&horizontal){
   const raw=page.node.Resources()?.lookupMaybe(PDFName.of('Font'),PDFDict)?.lookupMaybe(PDFName.of(font.resourceName),PDFDict);
   const base=raw?.lookupMaybe(PDFName.of('BaseFont'),PDFName)?.decodeText();
   if(base&&Object.values(FontNames).includes(base as FontNames)){
    const [l,b,r,t]=StandardFont.load(base as FontNames).FontBBox,sx=s.fontSize*s.horizontalScale!*linear[0]!/1000,sy=s.fontSize*linear[3]!/1000;
    box={x:l*sx,y:b*sy,w:(r-l)*sx,h:(t-b)*sy};
   }
  }
  if(!box){const c=page.getCropBox();return{box:{x:c.x,y:c.y,w:c.width,h:c.height},known:false};}
  if(box.w===0&&box.h===0)return{box:{x,y,w:0,h:0},known:true};
  const stroke=[1,2].includes(s.renderMode!)?strokes.get(s.opIndex):0;
  if(stroke===undefined)return{box:{x,y,w:0,h:0},known:false};
  const guard=.01+stroke*Math.hypot(...ct.slice(0,4));
  return{box:{x:x+box.x-guard,y:y+box.y-guard,w:box.w+2*guard,h:box.h+2*guard},known:true};
 };
}
