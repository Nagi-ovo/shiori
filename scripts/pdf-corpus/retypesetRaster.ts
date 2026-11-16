import assert from 'node:assert/strict';
import type {PdfRect} from '../../src/pdf/model/types';
export type RasterGlyph={box:readonly number[];inkBox?:readonly number[]};
type Raster={width:number;height:number;pixels?:Uint8Array};
const valid=(b:readonly number[])=>b.length===4&&b.every(Number.isFinite)&&b[2]!>=b[0]!&&b[3]!>=b[1]!;

/** 144 dpi: old nonwhite raster coverage inside native tight glyph ink bounds,
 * union the observed replacement text box. Dilate this union by exactly one
 * raster pixel (Chebyshev distance, 0.5 pt) for edge antialiasing/strokes.
 * This mask never consults the tier-1 proved region or the edit cover boxes. */
export function compareRetypesetRaster(before:Raster,after:Raster,oldGlyphs:readonly RasterGlyph[],newGlyphs:readonly RasterGlyph[]){
 assert.equal(after.width,before.width,'native page width changed');assert.equal(after.height,before.height,'native page height changed');
 assert(before.pixels&&after.pixels,'native raster missing');
 const width=Math.round(before.width*2),height=Math.round(before.height*2);
 assert.equal(before.pixels.length,width*height*4,'invalid native raster size');assert.equal(after.pixels.length,before.pixels.length,'native raster size changed');
 const mask=new Uint8Array(width*height),oldInk=oldGlyphs.map(g=>g.inkBox??g.box),newBounds=newGlyphs.map(g=>g.box);
 assert([...oldInk,...newBounds].every(valid),'invalid native glyph bounds');
 let newTextBox:PdfRect|undefined;
 if(newBounds.length){
  const x=Math.min(...newBounds.map(b=>b[0]!)),y=Math.min(...newBounds.map(b=>b[1]!));
  newTextBox={x,y,w:Math.max(...newBounds.map(b=>b[2]!))-x,h:Math.max(...newBounds.map(b=>b[3]!))-y};
 }
 const mark=(box:readonly number[],inkOnly:boolean)=>{
  const [l,b,r,t]=box as readonly [number,number,number,number];
  for(let y=Math.max(0,Math.floor((before.height-t)*2));y<Math.min(height,Math.ceil((before.height-b)*2));y++){
   for(let x=Math.max(0,Math.floor(l*2));x<Math.min(width,Math.ceil(r*2));x++){
    const p=y*width+x,offset=p*4;
    if(!inkOnly||before.pixels!.subarray(offset,offset+3).some(v=>v!==255))mask[p]=1;
   }
  }
 };
 for(const box of oldInk)mark(box,true);
 if(newTextBox)mark([newTextBox.x,newTextBox.y,newTextBox.x+newTextBox.w,newTextBox.y+newTextBox.h],false);
 const inside=(x:number,y:number)=>{
  for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(x+dx>=0&&x+dx<width&&y+dy>=0&&y+dy<height&&mask[(y+dy)*width+x+dx])return true;
  return false;
 };
 let changedPixels=0,changedPixelsOutsideRetypesetMask=0;
 for(let offset=0;offset<before.pixels.length;offset+=4){
  if(before.pixels.subarray(offset,offset+4).every((v,i)=>v===after.pixels![offset+i]))continue;
  changedPixels++;const p=offset/4;
  if(!inside(p%width,Math.floor(p/width)))changedPixelsOutsideRetypesetMask++;
 }
 assert.equal(changedPixelsOutsideRetypesetMask,0,'changed pixels outside retypeset mask');
 return {changedPixels,changedPixelsOutsideRetypesetMask,maskDilationPx:1,newTextBox};
}
