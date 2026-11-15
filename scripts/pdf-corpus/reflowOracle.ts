import assert from 'node:assert/strict';
import type {AppliedReflowManifest,ManifestGlyph} from '../../src/pdf/export/contentText/reflowManifest';
import type {PdfRect} from '../../src/pdf/model/types';
type Glyph={text:string;origin:readonly number[];fontHash?:string;nativePath?:unknown;inkPixels?:number};
type Snapshot={width:number;height:number;text:string;glyphs:readonly Glyph[];pixels?:Uint8Array};
const compact=(s:string)=>s.replace(/\s/gu,'');
const drift=(a:readonly number[],b:readonly number[])=>Math.hypot(a[0]!-b[0]!,a[1]!-b[1]!);
const match=(g:Glyph,e:ManifestGlyph)=>g.text===e.unicode&&drift(g.origin,e.origin)<=.005;
/** Only called for flag-on samples carrying a manifest. The ordinary oracle
 * remains unchanged. A manifest authorizes exact owned destinations, never
 * arbitrary drift or font changes elsewhere on the page. */
export function compareReflowNativePages(before:Snapshot,after:Snapshot,edit:{originalText:string;text:string;coverRects:readonly PdfRect[]},manifest:AppliedReflowManifest){
 assert(manifest.sourceHash&&manifest.dependencyHash,'missing manifest revision');
 const old=before.glyphs.filter(g=>compact(g.text)),actual=after.glyphs.filter(g=>compact(g.text));
 const source=manifest.source.filter(g=>compact(g.unicode)),output=manifest.output.filter(g=>compact(g.unicode));
 assert(source.length&&output.length,'empty manifest ownership');
 const at=old.findIndex(g=>match(g,source[0]!));assert(at>=0,'manifest source not found');
 source.forEach((e,i)=>{const g=old[at+i];assert(g&&match(g,e),'manifest source sequence/origin differs');if(e.fontHash)assert.equal(g.fontHash,e.fontHash,'manifest source font differs');});
 // The edit's native selection supplies independent logical text evidence;
 // the manifest cannot authorize deleting/changing additional owned letters.
 const inCover=(g:Glyph)=>edit.coverRects.some(r=>g.origin[0]!>=r.x-.01&&g.origin[0]!<=r.x+r.w+.01&&g.origin[1]!>=r.y-.01&&g.origin[1]!<=r.y+r.h+.01);
 const needle=compact(edit.originalText),count=Array.from(needle).length;
 assert(count&&old.every(g=>Array.from(g.text).length===1),'native audit requires scalar glyphs');
 const candidates=old.flatMap((_,i)=>{const selected=old.slice(i,i+count);return selected.length===count&&selected.every(inCover)&&selected.map(g=>g.text).join('')===needle?[i]:[];});
 assert.equal(candidates.length,1,'native edit source is missing/ambiguous');
 const target=candidates[0]!;
 assert(target>=at&&target+count<=at+source.length,'edit is outside manifest source');
 const logical=old.slice(0,target).map(g=>g.text).join('')+compact(edit.text)+old.slice(target+count).map(g=>g.text).join('');
 assert.equal(compact(after.text),logical,'native requested logical text mismatch');
 const expected=[...old.slice(0,at).map(g=>({text:g.text,origin:g.origin,original:g,replacement:false})),
  ...output.map(e=>{const original=e.oldOrigin?old.slice(at,at+source.length).find(g=>g.text===e.unicode&&drift(g.origin,e.oldOrigin!)<=.01):undefined;
   if(e.oldOrigin)assert(original,'owned output identity missing');
   return {text:e.unicode,origin:e.origin,original,replacement:!e.oldOrigin};}),
  ...old.slice(at+source.length).map(g=>({text:g.text,origin:g.origin,original:g,replacement:false}))];
 assert.equal(actual.length,expected.length,'native glyph count mismatch');assert.equal(compact(after.text),expected.map(e=>e.text).join(''),'native extracted text mismatch');
 const replacementIndices:number[]=[];let maxOriginDriftPt=0;
 actual.forEach((g,i)=>{const e=expected[i]!;assert.equal(g.text,e.text,'native glyph Unicode/order mismatch');
  const distance=drift(g.origin,e.origin);assert(distance<=.005,`native ${i>=at&&i<at+output.length?'destination':'untouched glyph drift'} ${distance}`);maxOriginDriftPt=Math.max(maxOriginDriftPt,distance);
  if(i>=at&&i<at+output.length&&output[i-at]!.fontHash)assert.equal(g.fontHash,output[i-at]!.fontHash,'manifest output font differs');
  if(e.original){assert.equal(g.fontHash,e.original.fontHash,'owned/untouched font program changed');assert.deepEqual(g.nativePath,e.original.nativePath,'owned/untouched outline changed');}
  if(e.replacement){replacementIndices.push(i);assert(g.nativePath&&(g.nativePath as unknown[]).length,'replacement path missing');assert((g.inkPixels??0)>0,'replacement has no ink');}
 });
 // Spaces have no painted ink, so compare their exact native origins too.
 const ownedSpaces=manifest.source.filter(g=>!compact(g.unicode));
 const retainedSpaces=before.glyphs.filter(g=>!compact(g.text)&&!ownedSpaces.some(e=>match(g,e))).map(g=>({text:g.text,origin:g.origin,original:g}));
 const intendedSpaces=manifest.output.filter(g=>!compact(g.unicode)).map(e=>({text:e.unicode,origin:e.origin,
  original:e.oldOrigin?before.glyphs.find(g=>g.text===e.unicode&&drift(g.origin,e.oldOrigin!)<=.01):undefined}));
 const spaces=after.glyphs.filter(g=>!compact(g.text)),expectedSpaces=[...retainedSpaces,...intendedSpaces];
 assert.equal(spaces.length,expectedSpaces.length,'native whitespace count changed');
 for(const e of expectedSpaces){const index=spaces.findIndex(g=>g.text===e.text&&drift(g.origin,e.origin)<=.005);assert(index>=0,'native whitespace destination drift');const [g]=spaces.splice(index,1);if(e.original)assert.equal(g!.fontHash,e.original.fontHash,'native whitespace font changed');}
 assert(before.pixels&&after.pixels,'native raster missing');assert.equal(before.pixels.length,after.pixels.length);
 const box=manifest.region.box;assert([box.x,box.y,box.w,box.h].every(Number.isFinite)&&box.w>0&&box.h>0,'invalid manifest bounds');
 const width=Math.round(before.width*2),height=Math.round(before.height*2);let changedPixels=0,changedPixelsOutsideBox=0;
 for(let p=0;p<before.pixels.length;p+=4)if(!before.pixels.subarray(p,p+4).every((v,i)=>v===after.pixels![p+i])){
  changedPixels++;const at=p/4,x=(at%width+.5)/2,y=(height-Math.floor(at/width)-.5)/2;
  if(x<box.x||x>box.x+box.w||y<box.y||y>box.y+box.h)changedPixelsOutsideBox++;
 }
 assert.equal(changedPixelsOutsideBox,0,'changed pixels outside manifest region');
 return {maxOriginDriftPt,changedPixels,changedPixelsOutsideBox,replacementGlyphs:replacementIndices.length,replacementIndices};
}
