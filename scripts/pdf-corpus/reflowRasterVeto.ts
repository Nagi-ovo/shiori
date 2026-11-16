import assert from 'node:assert/strict';
import type {AppliedReflowManifest} from '../../src/pdf/export/contentText/reflowManifest';

type Raster={width:number;height:number;pixels?:Uint8Array};
const valid=(b:{x:number;y:number;w:number;h:number})=>[b.x,b.y,b.w,b.h].every(Number.isFinite)&&b.w>0&&b.h>0;
/** Original native PDFium render at 144 dpi on opaque white. This can only
 * veto a plan: empty pixels confer no ownership/capacity and never change
 * the analytic mask. Every channel differing from background counts. */
export function vetoReflowRaster(original:Raster,region:AppliedReflowManifest['region']){
 const {mask,oldInk}=region;
 assert(mask?.length&&mask.every(valid),'raster veto: missing/invalid fixed mask');
 assert(oldInk?.length&&oldInk.every(valid),'raster veto: missing/invalid owned old ink');
 const width=Math.round(original.width*2),height=Math.round(original.height*2),pixels=original.pixels;
 assert(width>0&&height>0&&pixels?.length===width*height*4,'raster veto: missing/invalid 144 dpi original raster');
 const inside=(x:number,y:number,boxes:typeof mask)=>boxes.some(b=>x>=b.x&&x<=b.x+b.w&&y>=b.y&&y<=b.y+b.h);
 let originalInkPixelsInsideMask=0,unexplainedOriginalPixels=0;
 const firstUnexplained:{x:number;y:number}[]=[];
 for(let p=0;p<pixels.length;p+=4){
  if(pixels[p]===255&&pixels[p+1]===255&&pixels[p+2]===255&&pixels[p+3]===255)continue;
  const at=p/4,x=(at%width+.5)/2,y=(height-Math.floor(at/width)-.5)/2;
  if(!inside(x,y,mask))continue;
  originalInkPixelsInsideMask++;
  if(!inside(x,y,oldInk)){unexplainedOriginalPixels++;if(firstUnexplained.length<8)firstUnexplained.push({x,y});}
 }
 assert.equal(unexplainedOriginalPixels,0,`raster veto: unexplained original paint inside fixed mask ${JSON.stringify(firstUnexplained)}`);
 return {originalInkPixelsInsideMask,unexplainedOriginalPixels};
}
