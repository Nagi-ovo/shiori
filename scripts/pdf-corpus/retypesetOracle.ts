import assert from 'node:assert/strict';
import type {PdfRect} from '../../src/pdf/model/types';
import type {RetypesetManifest} from '../../src/pdf/export/contentText/retypesetTypes';
import {compareRetypesetRaster} from './retypesetRaster';
type Glyph={text:string;origin:readonly number[];box:readonly number[];inkBox?:readonly number[];fontHash?:string;nativePath?:unknown;inkPixels?:number;code?:number};
type Snapshot={width:number;height:number;text:string;glyphs:readonly Glyph[];pixels?:Uint8Array};
export type RetypesetEdit={originalText:string;text:string;coverRects:readonly PdfRect[]};
export type RetypesetPushedGlyph={origin:readonly number[];deltaY:number};
const compact=(s:string)=>s.replace(/\s/gu,'');
const drift=(a:readonly number[],b:readonly number[])=>Math.hypot(a[0]!-b[0]!,a[1]!-b[1]!);
const inside=(g:{origin:readonly number[]},r:PdfRect)=>g.origin[0]!>=r.x-.01&&g.origin[0]!<=r.x+r.w+.01&&g.origin[1]!>=r.y-.01&&g.origin[1]!<=r.y+r.h+.01;
const pushedInkInside=(g:Glyph,r:PdfRect)=>{
 const b=g.inkBox??g.box;
 // A positive bearing (notably superscripts) puts the baseline origin outside
 // the tight ink. Require the whole ink, never just an overlap with a region.
 return b[2]!>b[0]!&&b[3]!>b[1]!?b[0]!>=r.x-.01&&b[2]!<=r.x+r.w+.01&&b[1]!>=r.y-.01&&b[3]!<=r.y+r.h+.01:inside(g,r);
};

export function selectRetypesetSourceSpans<T extends {text:string;origin:readonly number[]}>(glyphs:readonly T[],edit:RetypesetEdit){
 const old=glyphs.filter(g=>compact(g.text)),sourceLines=edit.originalText.split('\n'),newLines=edit.text.split('\n');
 const candidates=sourceLines.map(source=>{
  const needle=compact(source),count=Array.from(needle).length;assert(count,'retypeset source text is empty');
  return old.flatMap((_,start)=>{
   const glyphs=old.slice(start,start+count);
   return glyphs.length===count&&glyphs.every(g=>edit.coverRects.some(r=>inside(g,r)))&&glyphs.map(g=>g.text).join('')===needle?[{start,glyphs}]:[];
  });
 });
 // Resolve the whole ordered selection, rather than rejecting identical text
 // on two selected lines. Retain at most two solutions to detect ambiguity.
 type Candidate=typeof candidates[number][number];
 const memo=new Map<string,Candidate[][]>();
 const resolve=(line:number,cursor:number):Candidate[][]=>{
  if(line===candidates.length)return [[]];
  const key=`${line}:${cursor}`,cached=memo.get(key);if(cached)return cached;
  const solutions:Candidate[][]=[];
  for(const candidate of candidates[line]!)if(candidate.start>=cursor){
   for(const tail of resolve(line+1,candidate.start+candidate.glyphs.length)){
    solutions.push([candidate,...tail]);if(solutions.length===2){memo.set(key,solutions);return solutions;}
   }
  }
  memo.set(key,solutions);return solutions;
 };
 const solutions=resolve(0,0);assert.equal(solutions.length,1,'positional retypeset source is missing/ambiguous');
 const selected=solutions[0]!;
 // Different hard-break counts replace the complete selected span. The
 // comparator still requires those source glyphs to be contiguous in its
 // owned paragraph; unrelated interleaved objects stay independently checked.
 const replacements=sourceLines.length!==newLines.length?
  [{glyphs:selected.flatMap(s=>s.glyphs),text:compact(edit.text.normalize('NFC'))}]:
  selected.flatMap((s,i)=>sourceLines[i]!==newLines[i]?[{glyphs:s.glyphs,text:compact(newLines[i]!.normalize('NFC'))}]:[]);
 assert(replacements.length,'retypeset requested text is unchanged');
 return replacements;
}

/** Approximate gate over saved native evidence, independent of tier-1 proofs.
 * Ownership comes from the source paragraph's glyphs, never its coarse bounds.
 * Untargeted text (including spaces and earlier paragraph lines) keeps identity.
 * Without source ownership only the positionally selected span is authorized. */
export function compareRetypesetNativePages(before:Snapshot,after:Snapshot,edit:RetypesetEdit,manifest?:RetypesetManifest,sourceOwnership?:readonly {origin:readonly number[];text?:string}[]){
 assert.equal(after.width,before.width,'native page width changed');assert.equal(after.height,before.height,'native page height changed');
 assert([...before.glyphs,...after.glyphs].every(g=>Array.from(g.text).length===1),'retypeset audit requires scalar glyphs');
 const old=before.glyphs.filter(g=>compact(g.text)),actual=after.glyphs.filter(g=>compact(g.text));
 assert.equal(compact(before.text),old.map(g=>g.text).join(''),'native source extracted text mismatch');
 assert.equal(compact(after.text),actual.map(g=>g.text).join(''),'native extracted text mismatch');
 const replacements=selectRetypesetSourceSpans(before.glyphs,edit),selected=new Set(replacements.flatMap(r=>r.glyphs));
 if(manifest){const r=manifest.paragraphBox;
  assert([r.x,r.y,r.w,r.h].every(Number.isFinite)&&r.w>0&&r.h>0,'invalid retypeset paragraph box');
  assert([...selected].every(g=>inside(g,r)),'edit outside retypeset paragraph');
 }
 const first=Math.min(...[...selected].map(g=>before.glyphs.indexOf(g))),last=Math.max(...[...selected].map(g=>before.glyphs.indexOf(g)));
 const ownedSourceGlyphs=before.glyphs.filter((g,i)=>sourceOwnership?sourceOwnership.some(o=>drift(o.origin,g.origin)<=.01&&(o.text===undefined||Array.from(o.text).includes(g.text))):selected.has(g)||(!compact(g.text)&&i>=first&&i<=last));
 const owned=new Set(ownedSourceGlyphs),logical=ownedSourceGlyphs.filter(g=>compact(g.text)).map(g=>({g,text:g.text}));
 for(const replacement of replacements.slice().reverse()){
  const at=logical.findIndex(e=>e.g===replacement.glyphs[0]);
  assert(at>=0&&replacement.glyphs.every((g,i)=>logical[at+i]?.g===g),'retypeset source interleaves paragraph text');
  logical.splice(at,replacement.glyphs.length,...Array.from(replacement.text,text=>({g:replacement.glyphs[0]!,text})));
 }
 const available=new Set(after.glyphs),pushedSourceGlyphs:RetypesetPushedGlyph[]=[];let maxOriginDriftPt=0,untargetedGlyphs=0;
 for(const g of before.glyphs){
  if(owned.has(g))continue;
  const region=manifest?.pushedRegions?.find(r=>pushedInkInside(g,r.before)),deltaY=region?region.before.y-region.after.y:0;
  const origin=[g.origin[0]!,g.origin[1]!-deltaY];
  const match=after.glyphs.find(a=>available.has(a)&&a.text===g.text&&a.fontHash===g.fontHash&&
   (g.code===undefined||a.code===g.code)&&drift(a.origin,origin)<=.01&&JSON.stringify(a.nativePath)===JSON.stringify(g.nativePath));
  assert(match,`untargeted glyph missing or changed font/codes/outline/position: ${JSON.stringify(g.text)} at ${g.origin} expected ${origin}`);available.delete(match);untargetedGlyphs++;
  if(region)pushedSourceGlyphs.push({origin:g.origin,deltaY});
  // Residual after an authorized same-column translation, not the push Δ itself.
  maxOriginDriftPt=Math.max(maxOriginDriftPt,drift(match.origin,origin));
 }
 const output=actual.filter(g=>available.has(g));
 assert.equal(output.map(g=>g.text).join(''),logical.map(e=>e.text).join(''),'retypeset requested local text mismatch (old span retained or neighbour lost)');
 if(output.length)assert(drift(output[0]!.origin,ownedSourceGlyphs.find(g=>compact(g.text))!.origin)<=.01,'retypeset output anchor moved away from edit');
 const replacementIndices=actual.flatMap((g,i)=>available.has(g)?[i]:[]);
 for(const g of output){assert(Array.isArray(g.nativePath)&&g.nativePath.length,'retypeset replacement path missing');assert((g.inkPixels??0)>0,'retypeset replacement has no ink');}
 const pushedBoxes=(manifest?.pushedRegions??[]).flatMap(r=>[[r.before.x,r.before.y,r.before.x+r.before.w,r.before.y+r.before.h] as const,[r.after.x,r.after.y,r.after.x+r.after.w,r.after.y+r.after.h] as const]);
 const raster=compareRetypesetRaster(before,after,ownedSourceGlyphs.filter(g=>compact(g.text)),output,pushedBoxes);
 return {maxOriginDriftPt,untargetedGlyphs,replacementGlyphs:replacementIndices.length,replacementIndices,ownedSourceGlyphs,pushedSourceGlyphs,...raster};
}
