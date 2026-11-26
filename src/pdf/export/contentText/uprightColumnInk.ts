import {PDFDict,PDFName,type PDFPage} from 'pdf-lib';
import type {ContentOp} from '../contentStreamEdit/tokenizer';
import type {ResolvedRunFont} from '../contentStreamEdit/replaceRun';
import type {ShowTextState} from '../contentStreamEdit/textState';
import type {PdfRect} from '../../model/types';
import {fontInputFromDict} from '../fontCoverage/pdfLibAdapter';
import {cffHulls} from '../fontCoverage/cffHulls';
import {createFontCoverage} from '../fontCoverage/coverage';
import {bounds,retypesetInk} from './retypesetInk';
import {withoutIdentityFdMatrices} from './cffMatrices';
import {proveType3Glyph} from '../fontCoverage/type3Proof';
import type {SubstituteSourceFont} from '../contentStreamEdit/substituteSource';

const flat=[1,0,0,1,0,0];
/** Column occupancy. Outline ink first; a bare CFF program whose FD
 * matrices are identities is outlined from a private copy without them; a
 * y-mirrored Type3 glyph is proved under the positive matrix and reflected. Non-upright frames (a rotated dash in
 * a column) are measured in an unrotated frame and mapped through the
 * glyph's linear transform. Unknown ink remains unknown. */
export function columnInk(page:PDFPage,fonts:ResolvedRunFont[],ops:ContentOp[]){
 const base=retypesetInk(page,fonts,ops),dict=page.node.Resources()?.lookupMaybe(PDFName.of('Font'),PDFDict),outlines=new Map<string,((code:number)=>PdfRect|undefined)|undefined>();
 const outline=(font:ResolvedRunFont)=>{
  if(outlines.has(font.resourceName))return outlines.get(font.resourceName);
  let hull:((code:number)=>PdfRect|undefined)|undefined;
  try{
   const raw=dict?.lookupMaybe(PDFName.of(font.resourceName),PDFDict);
   if(raw&&(font as SubstituteSourceFont).glyphFlipY){
    // Prove the glyph under the y-mirrored (positive) matrix, then reflect
    // its text-space ink back across the baseline.
    const type3=fontInputFromDict(raw),m=type3.fontMatrix!,mirror=[m[0]!,0,0,-m[3]!,m[4]!,-m[5]!];
    hull=code=>{const p=proveType3Glyph({...type3,fontMatrix:mirror},code);if(!p.ok)return;const b=p.proof.inkBounds;return b?{x:b.x,y:-(b.y+b.h),w:b.w,h:b.h}:{x:0,y:0,w:0,h:0};};
    outlines.set(font.resourceName,hull);return hull;
   }
   const input=raw&&!raw.has(PDFName.of('FontMatrix'))?fontInputFromDict(raw):undefined;
   const patched=input?.program&&!input.fontMatrix?withoutIdentityFdMatrices(input.program):undefined;
   const hulls=patched&&cffHulls(patched),coverage=patched&&createFontCoverage({...input!,program:patched});
   if(hulls&&coverage)hull=code=>{const gid=coverage.glyphIds.get(code.toString(16).padStart(font.bytesPerCode*2,'0'));try{return gid?hulls(gid):undefined;}catch{return;}};
  }catch{hull=undefined;}
  outlines.set(font.resourceName,hull);return hull;
 };
 return(font:ResolvedRunFont,code:number,s:ShowTextState,x:number,y:number)=>{
  const measured=base(font,code,s,x,y);if(measured.known||s.renderMode!==0)return measured;
  const tm=s.textMatrix!,ct=s.ctm!,L=[tm[0]!*ct[0]!+tm[1]!*ct[2]!,tm[0]!*ct[1]!+tm[1]!*ct[3]!,tm[2]!*ct[0]!+tm[3]!*ct[2]!,tm[2]!*ct[1]!+tm[3]!*ct[3]!];
  if(!L.every(Number.isFinite)||Math.abs(L[0]!*L[3]!-L[1]!*L[2]!)<1e-12)return measured;
  const local=base(font,code,{...s,textMatrix:flat,ctm:flat},0,0);
  let box=local.known?local.box:undefined;
  if(!box){const e=outline(font)?.(code);if(e&&[e.x,e.y,e.w,e.h].every(Number.isFinite)){const sx=s.fontSize*s.horizontalScale!,sy=s.fontSize;box={x:e.x*sx-.01,y:e.y*sy-.01,w:e.w*sx+.02,h:e.h*sy+.02};}}
  if(!box)return measured;
  const corners=[[box.x,box.y],[box.x+box.w,box.y],[box.x+box.w,box.y+box.h],[box.x,box.y+box.h]].map(([u,v])=>({x:x+u!*L[0]!+v!*L[2]!,y:y+u!*L[1]!+v!*L[3]!}));
  return{box:bounds(corners),known:true};
 };
}
