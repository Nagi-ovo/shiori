import assert from 'node:assert/strict';
import type {PdfRect} from '../../src/pdf/model/types';
import type {RetypesetManifest} from '../../src/pdf/export/contentText/retypesetTypes';
import {compareRetypesetRaster} from './retypesetRaster';
import {interleavedColumnText} from '../../src/pdf/export/contentText/uprightColumnStray';
type Glyph={text:string;origin:readonly number[];box:readonly number[];inkBox?:readonly number[];fontHash?:string;nativePath?:unknown;inkPixels?:number;code?:number};
type Snapshot={width:number;height:number;text:string;glyphs:readonly Glyph[];pixels?:Uint8Array};
export type RetypesetEdit={originalText:string;text:string;coverRects:readonly PdfRect[]};
export type RetypesetPushedGlyph={origin:readonly number[];deltaY:number;deltaX?:number};
const compact=(s:string)=>s.replace(/\s/gu,'');
const drift=(a:readonly number[],b:readonly number[])=>Math.hypot(a[0]!-b[0]!,a[1]!-b[1]!);
const inside=(g:{origin:readonly number[]},r:PdfRect)=>g.origin[0]!>=r.x-.01&&g.origin[0]!<=r.x+r.w+.01&&g.origin[1]!>=r.y-.01&&g.origin[1]!<=r.y+r.h+.01;
const pushedInkInside=(g:Glyph,r:PdfRect)=>{
 const b=g.inkBox??g.box;
 // A positive bearing (notably superscripts) puts the baseline origin outside
 // the tight ink. Require the whole ink, never just an overlap with a region.
 return b[2]!>b[0]!&&b[3]!>b[1]!?b[0]!>=r.x-.01&&b[2]!<=r.x+r.w+.01&&b[1]!>=r.y-.01&&b[3]!<=r.y+r.h+.01:inside(g,r);
};

/** Every way (at most two) the selection's lines lie, in order, on covered
 * source glyphs. */
function positionalSolutions<T extends {text:string;origin:readonly number[]}>(old:readonly T[],edit:RetypesetEdit){
 const sourceLines=edit.originalText.split('\n');
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
 return resolve(0,0);
}

/** The covered source glyphs of the whole selection, unchanged lines too,
 * when they lie in exactly one way. */
export function selectedRetypesetSourceGlyphs<T extends {text:string;origin:readonly number[]}>(glyphs:readonly T[],edit:RetypesetEdit){
 const solutions=positionalSolutions(glyphs.filter(g=>compact(g.text)),edit);
 return solutions.length===1?solutions[0]!.flatMap(s=>s.glyphs):undefined;
}

export function selectRetypesetSourceSpans<T extends {text:string;origin:readonly number[]}>(glyphs:readonly T[],edit:RetypesetEdit){
 const old=glyphs.filter(g=>compact(g.text)),sourceLines=edit.originalText.split('\n'),newLines=edit.text.split('\n');
 const solutions=positionalSolutions(old,edit);
 // Only a missing positional source may fall back to the stray-column reading;
 // two positional solutions stay an ambiguity and fail closed.
 if(!solutions.length){const stray=strayColumnSpans(old,edit);if(stray)return stray;}
 assert.equal(solutions.length,1,'positional retypeset source is missing/ambiguous');
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

/** A covered selection that interleaves cells of several stacked columns,
 * grouped here from native origins alone: the edit owns the one column it
 * changes, and only when it leaves every other column's characters in place
 * (the production text rule, interleavedColumnText). */
function strayColumnSpans<T extends {text:string;origin:readonly number[]}>(old:readonly T[],edit:RetypesetEdit){
 const covered=old.filter(g=>edit.coverRects.some(r=>inside(g,r)));
 const heights=covered.flatMap(g=>{const b=(g as {box?:readonly number[]}).box;return b?[b[3]!-b[1]!]:[];}).sort((a,b)=>a-b),h=heights[Math.floor(heights.length/2)];
 if(!h)return;
 const columns:T[][]=[];
 for(const g of covered){const k=columns.find(k=>Math.abs(k[0]!.origin[0]!-g.origin[0]!)<h*.3);if(k)k.push(g);else columns.push([g]);}
 // Columns run right to left, each top down; no column holds two cells on a row.
 columns.sort((a,b)=>b[0]!.origin[0]!-a[0]!.origin[0]!);for(const k of columns)k.sort((a,b)=>b.origin[1]!-a.origin[1]!);
 if(columns.some(k=>k.some((g,i)=>i>0&&k[i-1]!.origin[1]!-g.origin[1]!<h*.5)))return;
 const text=interleavedColumnText(edit.originalText,edit.text,columns.map(k=>k.map(g=>g.text)));
 const owned=text&&columns[text.column]!;
 return owned&&stackedColumnOwnership(owned)?[{glyphs:owned,text:compact(text.text.normalize('NFC'))}]:undefined;
}

/** An upright vertical selection, read from native origins alone: glyphs
 * descend one column at a time and each new column starts right of nothing
 * already read (columns run right to left). Ownership is exactly those
 * glyphs; everything else on the page must stay unchanged. Horizontal text,
 * whose successive glyphs share a baseline, never satisfies this. */
export function stackedColumnOwnership(glyphs:readonly {text:string;origin:readonly number[]}[]){
 if(glyphs.length<3)return;
 const steps=glyphs.slice(1).map((g,i)=>glyphs[i]!.origin[1]!-g.origin[1]!).filter(d=>d>0).sort((a,b)=>a-b),pitch=steps[Math.floor(steps.length/2)];
 if(!pitch)return;
 let columns=1;
 for(let i=1;i<glyphs.length;i++){
  const a=glyphs[i-1]!.origin,b=glyphs[i]!.origin,dx=b[0]!-a[0]!,dy=a[1]!-b[1]!;
  if(Math.abs(dx)<pitch*.3&&dy>pitch*.5&&dy<pitch*1.5)continue;
  if(dx<-pitch*.5&&dy<0){columns++;continue;}
  return;
 }
 if(glyphs.length/columns<3)return;
 return Object.assign(glyphs.map(g=>({origin:[g.origin[0]!,g.origin[1]!],text:g.text})),{pitch});
}

/** A column too short for stackedColumnOwnership (two cells, or cells split
 * into overlay rows), read from native origins alone: the glyphs stack at one
 * pitch, and a run of at least three page glyphs stacks at that pitch, either
 * through them in their own column or, row for row, in the column of the
 * nearest glyph on their rows. No glyph sits nearer than 1.3 pitches on a row
 * of the selection or of that run, which horizontal line starts never pass. */
export function gridColumnOwnership(glyphs:readonly {text:string;origin:readonly number[]}[],page:readonly {text:string;origin:readonly number[]}[]){
 if(glyphs.length<2)return;
 const pitch=glyphs[0]!.origin[1]!-glyphs[1]!.origin[1]!,x=glyphs[0]!.origin[0]!;
 const same=(d:number)=>Math.abs(d-pitch)<=pitch*.03,ink=page.filter(g=>compact(g.text));
 if(!(pitch>0)||glyphs.some((g,i)=>Math.abs(g.origin[0]!-x)>pitch*.3||i>0&&!same(glyphs[i-1]!.origin[1]!-g.origin[1]!)))return;
 const nearest=(g:{origin:readonly number[]})=>{let best:typeof ink[number]|undefined,d=Infinity;for(const o of ink)if(o.origin!==g.origin&&drift(o.origin,g.origin)>1e-6&&Math.abs(o.origin[1]!-g.origin[1]!)<pitch*.5&&Math.abs(o.origin[0]!-g.origin[0]!)<d){d=Math.abs(o.origin[0]!-g.origin[0]!);best=o;}return{best,d};};
 const clear=(list:readonly {origin:readonly number[]}[])=>list.every(g=>nearest(g).d>=pitch*1.3);
 const run=(at:number,from:{origin:readonly number[]})=>{
  const column=ink.filter(g=>Math.abs(g.origin[0]!-at)<pitch*.3).sort((a,b)=>b.origin[1]!-a.origin[1]!);
  let i=column.findIndex(g=>Math.abs(g.origin[1]!-from.origin[1]!)<pitch*.05),j=i;if(i<0)return[];
  while(i>0&&same(column[i-1]!.origin[1]!-column[i]!.origin[1]!))i--;
  while(j<column.length-1&&same(column[j]!.origin[1]!-column[j+1]!.origin[1]!))j++;
  return column.slice(i,j+1);
 };
 const onRows=(list:readonly {origin:readonly number[]}[])=>glyphs.every(g=>list.some(o=>Math.abs(o.origin[1]!-g.origin[1]!)<pitch*.05));
 if(!clear(glyphs))return;
 const own=run(x,glyphs[0]!),near=glyphs.map(g=>nearest(g).best);
 const other=near.every(n=>n&&Math.abs(n.origin[0]!-near[0]!.origin[0]!)<pitch*.3)?run(near[0]!.origin[0]!,glyphs[0]!):[];
 const evidence=[own,other].find(r=>r.length>=3&&onRows(r)&&clear(r));
 return evidence&&Object.assign(glyphs.map(g=>({origin:[g.origin[0]!,g.origin[1]!],text:g.text})),{pitch});
}

// A column ownership read elsewhere from native glyphs and source fonts
// (identityVColumnOwnership) carries its own measured pitch.
const ownershipColumn=(o:unknown)=>{const pitch=(o as {pitch?:unknown}|undefined)?.pitch;return typeof pitch==='number'&&pitch>0?{pitch}:undefined;};

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
  // A column flow may also translate a region sideways (into the next column).
  const region=manifest?.pushedRegions?.find(r=>pushedInkInside(g,r.before)),deltaY=region?region.before.y-region.after.y:0,deltaX=region?region.after.x-region.before.x:0;
  const origin=[g.origin[0]!+deltaX,g.origin[1]!-deltaY];
  const match=after.glyphs.find(a=>available.has(a)&&a.text===g.text&&a.fontHash===g.fontHash&&
   (g.code===undefined||a.code===g.code)&&drift(a.origin,origin)<=.01&&JSON.stringify(a.nativePath)===JSON.stringify(g.nativePath));
  assert(match,`untargeted glyph missing or changed font/codes/outline/position: ${JSON.stringify(g.text)} at ${g.origin} expected ${origin}`);available.delete(match);untargetedGlyphs++;
  if(region)pushedSourceGlyphs.push({origin:g.origin,deltaY,...(deltaX?{deltaX}:{})});
  // Residual after an authorized same-column translation, not the push Δ itself.
  maxOriginDriftPt=Math.max(maxOriginDriftPt,drift(match.origin,origin));
 }
 const output=actual.filter(g=>available.has(g));
 assert.equal(output.map(g=>g.text).join(''),logical.map(e=>e.text).join(''),'retypeset requested local text mismatch (old span retained or neighbour lost)');
 // In a stacked column the anchor is the first source cell: a narrower or
 // differently centred glyph keeps the cell, not the left origin.
 const ownedInk=ownedSourceGlyphs.filter(g=>compact(g.text)),column=stackedColumnOwnership(ownedInk)??gridColumnOwnership(ownedInk,before.glyphs)??ownershipColumn(sourceOwnership),anchor=ownedSourceGlyphs.find(g=>compact(g.text))!.origin;
 if(output.length)assert(column?Math.abs(output[0]!.origin[0]!-anchor[0]!)<=column.pitch/2&&Math.abs(output[0]!.origin[1]!-anchor[1]!)<=column.pitch/2:drift(output[0]!.origin,anchor)<=.01,'retypeset output anchor moved away from edit');
 const replacementIndices=actual.flatMap((g,i)=>available.has(g)?[i]:[]);
 // A Type 3 glyph is a content stream with no embedded program: PDFium reports
 // neither a font hash nor an outline, so rendered ink is its paint evidence.
 for(const g of output){assert(Array.isArray(g.nativePath)&&g.nativePath.length||g.nativePath===null&&g.fontHash===undefined,'retypeset replacement path missing');assert((g.inkPixels??0)>0,'retypeset replacement has no ink');}
 const pushedBoxes=(manifest?.pushedRegions??[]).flatMap(r=>[[r.before.x,r.before.y,r.before.x+r.before.w,r.before.y+r.before.h] as const,[r.after.x,r.after.y,r.after.x+r.after.w,r.after.y+r.after.h] as const]);
 const raster=compareRetypesetRaster(before,after,ownedSourceGlyphs.filter(g=>compact(g.text)),output,pushedBoxes);
 return {maxOriginDriftPt,untargetedGlyphs,replacementGlyphs:replacementIndices.length,replacementIndices,ownedSourceGlyphs,pushedSourceGlyphs,...raster};
}
