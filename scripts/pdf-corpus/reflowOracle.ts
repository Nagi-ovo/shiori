import assert from 'node:assert/strict';
import type {AppliedReflowManifest,ManifestGlyph} from '../../src/pdf/export/contentText/reflowManifest';
import type {PdfRect} from '../../src/pdf/model/types';
import {vetoReflowRaster} from './reflowRasterVeto';
type Glyph={text:string;origin:readonly number[];fontHash?:string;nativePath?:unknown;inkPixels?:number};
type Snapshot={width:number;height:number;text:string;glyphs:readonly Glyph[];pixels?:Uint8Array};
const compact=(s:string)=>s.replace(/\s/gu,'');
const drift=(a:readonly number[],b:readonly number[])=>Math.hypot(a[0]!-b[0]!,a[1]!-b[1]!);
const match=(g:Glyph,e:ManifestGlyph)=>g.text===e.unicode&&drift(g.origin,e.origin)<=.005;
function matchCluster(glyphs:readonly Glyph[],at:number,e:ManifestGlyph,tolerance=.005){
 const scalars=Array.from(e.unicode),components=glyphs.slice(at,at+scalars.length);
 return components.length===scalars.length&&components.every((g,i)=>Array.from(g.text).length===1&&g.text===scalars[i]&&drift(g.origin,e.origin)<=tolerance)?components:undefined;
}
/** Only called for flag-on samples carrying a manifest. The ordinary oracle
 * remains unchanged. A manifest authorizes exact owned destinations, never
 * arbitrary drift or font changes elsewhere on the page. */
export function compareReflowNativePages(before:Snapshot,after:Snapshot,edit:{originalText:string;text:string;coverRects:readonly PdfRect[]},manifest:AppliedReflowManifest,backdrop?:Snapshot){
 assert(manifest.sourceHash&&manifest.dependencyHash,'missing manifest revision');
 const old=before.glyphs.filter(g=>compact(g.text)),actual=after.glyphs.filter(g=>compact(g.text));
 const source=manifest.source.filter(g=>compact(g.unicode)),output=manifest.output.filter(g=>compact(g.unicode));
 assert(source.length&&output.length,'empty manifest ownership');
 const at=old.findIndex((_,i)=>matchCluster(old,i,source[0]!));assert(at>=0,'manifest source not found');
 let sourceEnd=at;
 for(const e of source){
  const components=matchCluster(old,sourceEnd,e);assert(components,'manifest source sequence/origin differs');
  if(e.fontHash)for(const g of components)assert.equal(g.fontHash,e.fontHash,'manifest source font differs');
  sourceEnd+=components.length;
 }
 // The edit's native selection supplies independent logical text evidence;
 // the manifest cannot authorize deleting/changing additional owned letters.
 const inCover=(g:Glyph)=>edit.coverRects.some(r=>g.origin[0]!>=r.x-.01&&g.origin[0]!<=r.x+r.w+.01&&g.origin[1]!>=r.y-.01&&g.origin[1]!<=r.y+r.h+.01);
 const needle=compact(edit.originalText),count=Array.from(needle).length;
 assert(count&&old.every(g=>Array.from(g.text).length===1),'native audit requires scalar glyphs');
 const candidates=old.flatMap((_,i)=>{const selected=old.slice(i,i+count);return selected.length===count&&selected.every(inCover)&&selected.map(g=>g.text).join('')===needle?[i]:[];});
 assert.equal(candidates.length,1,'native edit source is missing/ambiguous');
 const target=candidates[0]!;
 assert(target>=at&&target+count<=sourceEnd,'edit is outside manifest source');
 const logical=old.slice(0,target).map(g=>g.text).join('')+compact(edit.text)+old.slice(target+count).map(g=>g.text).join('');
 assert.equal(compact(after.text),logical,'native requested logical text mismatch');
 const owned=old.slice(at,sourceEnd);
 const expectedOutput=output.flatMap(e=>{
  const start=e.oldOrigin?owned.findIndex((_,i)=>matchCluster(owned,i,{...e,origin:e.oldOrigin!},.01)):-1;
  if(e.oldOrigin)assert(start>=0,'owned output identity missing');
  return Array.from(e.unicode).map((text,i)=>({text,origin:e.origin,original:e.oldOrigin?owned[start+i]:undefined,replacement:!e.oldOrigin,fontHash:e.fontHash}));
 });
 const expected=[...old.slice(0,at).map(g=>({text:g.text,origin:g.origin,original:g,replacement:false})),...expectedOutput,
  ...old.slice(sourceEnd).map(g=>({text:g.text,origin:g.origin,original:g,replacement:false}))];
 assert.equal(actual.length,expected.length,'native glyph count mismatch');assert.equal(compact(after.text),expected.map(e=>e.text).join(''),'native extracted text mismatch');
 const replacementIndices:number[]=[];let maxOriginDriftPt=0;
 actual.forEach((g,i)=>{const e=expected[i]!;assert.equal(g.text,e.text,'native glyph Unicode/order mismatch');
  const distance=drift(g.origin,e.origin);assert(distance<=.005,`native ${i>=at&&i<at+expectedOutput.length?'destination':'untouched glyph drift'} ${distance}`);maxOriginDriftPt=Math.max(maxOriginDriftPt,distance);
  if(i>=at&&i<at+expectedOutput.length&&expectedOutput[i-at]!.fontHash)assert.equal(g.fontHash,expectedOutput[i-at]!.fontHash,'manifest output font differs');
  if(e.original){assert.equal(g.fontHash,e.original.fontHash,'owned/untouched font program changed');assert.deepEqual(g.nativePath,e.original.nativePath,'owned/untouched outline changed');}
  if(e.replacement){replacementIndices.push(i);assert(g.nativePath&&(g.nativePath as unknown[]).length,'replacement path missing');assert((g.inkPixels??0)>0,'replacement has no ink');}
 });
 // Spaces have no painted ink, so compare their exact native origins too.
 // PDFium can omit an isolated source space even in the original. An
 // unchanged code at the same origin/font need not acquire native visibility.
 let nativeUnobservableUnchangedSpaces=0;
 const ownedSpaces=manifest.source.filter(g=>!compact(g.unicode));
 const retainedSpaces=before.glyphs.filter(g=>!compact(g.text)&&!ownedSpaces.some(e=>match(g,e))).map(g=>({text:g.text,origin:g.origin,original:g}));
 const intendedSpaces=manifest.output.filter(g=>!compact(g.unicode)).flatMap(e=>{
  const original=e.oldOrigin?before.glyphs.find(g=>g.text===e.unicode&&drift(g.origin,e.oldOrigin!)<=.01):undefined;
  if(!original&&e.oldOrigin&&e.fontHash&&drift(e.origin,e.oldOrigin)===0&&ownedSpaces.some(s=>
   s.unicode===e.unicode&&s.fontHash===e.fontHash&&drift(s.origin,e.oldOrigin!)===0)){
   nativeUnobservableUnchangedSpaces++;return [];
  }
  return [{text:e.unicode,origin:e.origin,original}];
 });
 const spaces=after.glyphs.filter(g=>!compact(g.text)),expectedSpaces=[...retainedSpaces,...intendedSpaces];
 assert.equal(spaces.length,expectedSpaces.length,'native whitespace count changed');
 for(const e of expectedSpaces){const index=spaces.findIndex(g=>g.text===e.text&&drift(g.origin,e.origin)<=.005);assert(index>=0,'native whitespace destination drift');const [g]=spaces.splice(index,1);if(e.original)assert.equal(g!.fontHash,e.original.fontHash,'native whitespace font changed');}
 assert(before.pixels&&after.pixels,'native raster missing');assert.equal(before.pixels.length,after.pixels.length);
 assert.equal(after.width,before.width,'native page width changed');assert.equal(after.height,before.height,'native page height changed');
 const box=manifest.region.box;assert([box.x,box.y,box.w,box.h].every(Number.isFinite)&&box.w>0&&box.h>0,'invalid manifest bounds');
 const mask=manifest.region.mask??[box];assert(mask.length&&mask.every(b=>[b.x,b.y,b.w,b.h].every(Number.isFinite)&&b.w>0&&b.h>0),'invalid manifest mask');
 const width=Math.round(before.width*2),height=Math.round(before.height*2);let changedPixels=0,changedPixelsOutsideBox=0,changedPixelsOutsideMask=0;
 for(let p=0;p<before.pixels.length;p+=4)if(!before.pixels.subarray(p,p+4).every((v,i)=>v===after.pixels![p+i])){
  changedPixels++;const at=p/4,x=(at%width+.5)/2,y=(height-Math.floor(at/width)-.5)/2;
  if(x<box.x||x>box.x+box.w||y<box.y||y>box.y+box.h)changedPixelsOutsideBox++;
  if(!mask.some(b=>x>=b.x&&x<=b.x+b.w&&y>=b.y&&y<=b.y+b.h))changedPixelsOutsideMask++;
 }
 assert.equal(changedPixelsOutsideBox,0,'changed pixels outside manifest region');
 assert.equal(changedPixelsOutsideMask,0,'changed pixels outside manifest mask');
 const rasterVeto=vetoReflowRaster(before,manifest.region,backdrop);
 return {maxOriginDriftPt,changedPixels,changedPixelsOutsideBox,changedPixelsOutsideMask,nativeUnobservableUnchangedSpaces,...rasterVeto,replacementGlyphs:replacementIndices.length,replacementIndices};
}
