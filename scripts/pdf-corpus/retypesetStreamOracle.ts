import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PDFDict,PDFName,type PDFPage} from 'pdf-lib';
import {fontInputFromDict} from '../../src/pdf/export/fontCoverage/pdfLibAdapter';
import type {Type1Options} from '../../src/pdf/export/fontCoverage/type1Support';
import {address,paragraphGroups} from '../../src/pdf/export/contentText/retypesetSource';
import {pageFormGlyphs} from '../../src/pdf/export/contentText/retypesetForms';
import {selectRetypesetSourceSpans,type RetypesetEdit} from './retypesetOracle';
import {compareRetypesetFormWalk} from './retypesetFormWalkOracle';

/** Recover membership from the immutable source's text frames/scopes and
 * paragraph grouping, rather than authorizing every object in a bounding box.
 * No replacement planning, writer output or exact-tier proofs are used. */
export function retypesetSourceOwnership(page:PDFPage,native:readonly {text:string;origin:readonly number[]}[],edit:RetypesetEdit,options:Type1Options={}){
 const streams=compareRetypesetFormWalk(page,page,options).before;
 const spans=selectRetypesetSourceSpans(native,edit),first=spans[0]!;
 let prefix=0;const replacement=Array.from(first.text);
 while(prefix<first.glyphs.length&&prefix<replacement.length&&first.glyphs[prefix]!.text===replacement[prefix])prefix++;
 const anchor=first.glyphs[Math.min(prefix,first.glyphs.length-1)]!;
 const occurrence=streams.nodes.find(n=>pageFormGlyphs(n).some(g=>Math.hypot(g.x-anchor.origin[0]!,g.y-anchor.origin[1]!)<=.01));
 const projected=occurrence?pageFormGlyphs(occurrence,false):[];
 const at=projected.find(g=>Math.hypot(g.x-anchor.origin[0]!,g.y-anchor.origin[1]!)<=.01);
 const target=occurrence?.read.glyphs.find(g=>at&&address(g.glyph)===address(at.glyph));
 assert(target,'retypeset native span has no source glyph');
 const {group}=paragraphGroups(occurrence!.read.glyphs,occurrence!.ops,target);assert(group,'retypeset source paragraph missing');
 const line=group.lines.findIndex(l=>l.glyphs.some(g=>address(g.glyph)===address(target.glyph)));
 return group.lines.slice(line).flatMap(l=>l.glyphs.map(g=>{
  const p=projected.find(t=>address(t.glyph)===address(g.glyph))!;
  return{origin:[p.glyph.coreQuad[0].x,p.glyph.coreQuad[0].y],text:g.text,sourceKey:`${occurrence!.key}:${address(g.glyph)}`};
 }));
}

/** Supplement native Unicode/outline checks with the saved character codes,
 * including invisible spaces. Read both saved streams; never trust a producer
 * assertion or object numbers (pdf-lib may renumber them while exporting). */
export function assertRetypesetStreamIdentity(before:PDFPage,after:PDFPage,owned:readonly {origin:readonly number[];sourceKey?:string}[],options:Type1Options={}){
 const walks=compareRetypesetFormWalk(before,after,options);
 const snapshot=(streams:typeof walks.before)=>{
  return streams.nodes.flatMap(node=>{
   assert(node.read.walk.ok,'retypeset stream glyph walk failed');
   if(node.raw)assert(!node.read.walk.unplacedText,'retypeset Form has unmeasurable glyphs');
   const fonts=node.page.node.Resources()?.lookupMaybe(PDFName.of('Font'),PDFDict),hashes=new Map<string,string>();
   for(const {glyph:g}of node.read.glyphs)if(!hashes.has(g.fontName)){
    const font=fonts?.lookupMaybe(PDFName.of(g.fontName),PDFDict);assert(font,'retypeset stream font missing');
    hashes.set(g.fontName,createHash('sha256').update(JSON.stringify(fontInputFromDict(font))).digest('hex'));
   }
   return pageFormGlyphs(node,false).map(({glyph:g})=>({sourceKey:`${node.key}:${address(g)}`,code:g.code,font:hashes.get(g.fontName),quad:g.coreQuad}));
  });
 };
 const original=snapshot(walks.before),actual=snapshot(walks.after),available=new Set(actual);let checked=0;
 for(const g of original){
  if(owned.some(o=>o.sourceKey!==undefined?o.sourceKey===g.sourceKey:Math.hypot(o.origin[0]!-g.quad[0].x,o.origin[1]!-g.quad[0].y)<=.01))continue;
  const match=actual.find(a=>available.has(a)&&a.code===g.code&&a.font===g.font&&a.quad.every((p,i)=>Math.hypot(p.x-g.quad[i]!.x,p.y-g.quad[i]!.y)<=.01));
  assert(match,'untargeted stream glyph codes/font/position changed');available.delete(match);checked++;
 }
 return checked;
}
