import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PDFDict,PDFName,type PDFPage} from 'pdf-lib';
import {fontInputFromDict} from '../../src/pdf/export/fontCoverage/pdfLibAdapter';
import type {Type1Options} from '../../src/pdf/export/fontCoverage/type1Support';
import {inspectRunPage} from '../../src/pdf/export/contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../../src/pdf/export/contentStreamEdit/tokenizer';
import {address,paragraphGroups,readRetypesetSource} from '../../src/pdf/export/contentText/retypesetSource';
import {selectRetypesetSourceSpans,type RetypesetEdit} from './retypesetOracle';

/** Recover membership from the immutable source's text frames/scopes and
 * paragraph grouping, rather than authorizing every object in a bounding box.
 * No replacement planning, writer output or exact-tier proofs are used. */
export function retypesetSourceOwnership(page:PDFPage,native:readonly {text:string;origin:readonly number[]}[],edit:RetypesetEdit,options:Type1Options={}){
 const stream=inspectRunPage(page);assert(stream.ok,'retypeset stream unreadable');
 const ops=tokenizeContentStream(stream.bytes),source=readRetypesetSource(page,ops,options);assert(source.walk.ok,'retypeset source walk failed');
 const spans=selectRetypesetSourceSpans(native,edit),first=spans[0]!;
 let prefix=0;const replacement=Array.from(first.text);
 while(prefix<first.glyphs.length&&prefix<replacement.length&&first.glyphs[prefix]!.text===replacement[prefix])prefix++;
 const anchor=first.glyphs[Math.min(prefix,first.glyphs.length-1)]!;
 const target=source.glyphs.find(g=>Math.hypot(g.x-anchor.origin[0]!,g.y-anchor.origin[1]!)<=.01);
 assert(target,'retypeset native span has no source glyph');
 const {group}=paragraphGroups(source.glyphs,ops,target);assert(group,'retypeset source paragraph missing');
 const line=group.lines.findIndex(l=>l.glyphs.some(g=>address(g.glyph)===address(target.glyph)));
 return group.lines.slice(line).flatMap(l=>l.glyphs.map(g=>({origin:[g.glyph.coreQuad[0].x,g.glyph.coreQuad[0].y],text:g.text,sourceKey:address(g.glyph)})));
}

/** Supplement native Unicode/outline checks with the saved character codes,
 * including invisible spaces. Read both saved streams; never trust a producer
 * assertion or object numbers (pdf-lib may renumber them while exporting). */
export function assertRetypesetStreamIdentity(before:PDFPage,after:PDFPage,owned:readonly {origin:readonly number[];sourceKey?:string}[],options:Type1Options={}){
 const snapshot=(page:PDFPage)=>{
  const stream=inspectRunPage(page);assert(stream.ok,'retypeset stream unreadable');
  const source=readRetypesetSource(page,tokenizeContentStream(stream.bytes),options);assert(source.walk.ok,'retypeset stream glyph walk failed');
  const fonts=page.node.Resources()?.lookupMaybe(PDFName.of('Font'),PDFDict),hashes=new Map<string,string>();
  for(const {glyph:g}of source.glyphs)if(!hashes.has(g.fontName)){
   const font=fonts?.lookupMaybe(PDFName.of(g.fontName),PDFDict);assert(font,'retypeset stream font missing');
   hashes.set(g.fontName,createHash('sha256').update(JSON.stringify(fontInputFromDict(font))).digest('hex'));
  }
  return source.glyphs.map(({glyph:g})=>({sourceKey:address(g),code:g.code,font:hashes.get(g.fontName),quad:g.coreQuad}));
 };
 const original=snapshot(before),actual=snapshot(after),available=new Set(actual);let checked=0;
 for(const g of original){
  if(owned.some(o=>o.sourceKey!==undefined?o.sourceKey===g.sourceKey:Math.hypot(o.origin[0]!-g.quad[0].x,o.origin[1]!-g.quad[0].y)<=.01))continue;
  const match=actual.find(a=>available.has(a)&&a.code===g.code&&a.font===g.font&&a.quad.every((p,i)=>Math.hypot(p.x-g.quad[i]!.x,p.y-g.quad[i]!.y)<=.01));
  assert(match,'untargeted stream glyph codes/font/position changed');available.delete(match);checked++;
 }
 return checked;
}
