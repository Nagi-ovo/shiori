import {expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import type {openPdfium} from '../../../../scripts/pdf-inplace/nativePdfium';

/** Poppler raster ink provides an independent placement check. Text bbox
 * output describes vertical cells rather than the horizontal glyph origin. */
export function popplerVerticalOrigins(path:string,page:ReturnType<ReturnType<typeof openPdfium>['inspectPage']>){
 const result=spawnSync('pdftoppm',['-r','144','-singlefile',path],{maxBuffer:20_000_000});expect(result.status).toBe(0);
 const header=/^P6\s+(\d+)\s+(\d+)\s+255\s/u.exec(result.stdout.subarray(0,100).toString('ascii'));expect(header).not.toBeNull();
 const width=Number(header![1]),height=Number(header![2]),pixels=result.stdout.subarray(header![0].length);
 expect(pixels.length).toBe(width*height*3);
 return page.glyphs.map(g=>{
  const [left,bottom,right,top]=g.inkBox;let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(let y=Math.max(0,Math.floor((page.height-top-.5)*2));y<Math.min(height,Math.ceil((page.height-bottom+.5)*2));y++)
   for(let x=Math.max(0,Math.floor((left-.5)*2));x<Math.min(width,Math.ceil((right+.5)*2));x++){
    const offset=(y*width+x)*3;if(Math.min(pixels[offset]!,pixels[offset+1]!,pixels[offset+2]!)>=128)continue;
    minX=Math.min(minX,x/2);maxX=Math.max(maxX,(x+1)/2);minY=Math.min(minY,page.height-(y+1)/2);maxY=Math.max(maxY,page.height-y/2);
   }
  expect(Number.isFinite(minX)).toBe(true);
  const delta=[minX-left,minY-bottom,maxX-right,maxY-top];expect(Math.max(...delta.map(Math.abs))).toBeLessThanOrEqual(.6);
  const inferredOrigin=[g.origin[0]+delta[0]!,g.origin[1]+delta[1]!];
  return{text:g.text,PDFiumOrigin:g.origin,PopplerOriginFromInk:inferredOrigin,maxInkEdgeDifferencePt:Math.max(...delta.map(Math.abs))};
 });
}
