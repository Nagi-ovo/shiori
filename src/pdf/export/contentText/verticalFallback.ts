import fontkit from '@pdf-lib/fontkit';
import {PDFArray,PDFDict,PDFName,type PDFDocument} from 'pdf-lib';
import {prepareRetypesetFallback} from './retypesetFallback';
import {loadFallbackFont,type FallbackOptions} from '../contentStreamEdit/fallbackFont';
import type {FontChoice} from '../fonts/fontService';
import {readVerticalFont} from './verticalFont';
import {verticalProgramMetrics} from './verticalProgramMetrics';
import {requiresVerticalAlternate,uprightNominal} from './uprightColumnGlyphs';

// Upright one-scalar CJK. Punctuation, combining clusters, and compact
// horizontal digits require separate glyph proofs (an observed source code).
export function simpleVerticalText(text:string){
 return Array.from(text).every(c=>/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(c)&&!/[\u30fc\u30fd\u30fe\u309d\u309e\u30a0]/u.test(c));
}
export async function prepareVerticalFallback(doc:PDFDocument,resource:string,face:FontChoice,text:readonly string[],options:FallbackOptions){
 if(text.some(c=>/\p{M}/u.test(c)))throw Error('vertical-glyph: combining clusters have no vertical proof');
 const data=await loadFallbackFont(face,options),parsed=fontkit.create(data);
 const measure=verticalProgramMetrics(data);
 // Han and full-size kana are upright in their nominal form. Any other
 // scalar is accepted only when neither vert nor vrt2 substitutes it.
 for(const c of text){
  if(!uprightNominal(c)&&requiresVerticalAlternate(c,parsed))throw Error(`vertical-glyph: substitute ${JSON.stringify(c)} requires a vertical alternate`);
 }
 const p=await prepareRetypesetFallback(doc,resource,face,[...new Set(text)],{loadFont:async()=>data});
 const raw=doc.context.lookup(p.ref,PDFDict),child=raw.lookup(PDFName.of('DescendantFonts'),PDFArray).lookup(0,PDFDict),rows:(number|number[])[]=[],u=parsed.unitsPerEm;
 for(const c of new Set(text)){
  const bytes=p.resolved.canEncode!(c);if(!bytes.ok)throw Error('vertical-glyph: substitute cannot encode');
  const glyph=parsed.glyphForCodePoint(c.codePointAt(0)!),metric=measure(glyph.id,glyph.cbox.maxY),origin=metric.origin;
  // Canonical integer dictionary values give both engines the same origin.
  rows.push(bytes.bytes[0]!*256+bytes.bytes[1]!,[-Math.round(metric.advance*1000/u),Math.round(glyph.advanceWidth*500/u),Math.round(origin*1000/u)]);
 }
 raw.set(PDFName.of('Encoding'),PDFName.of('Identity-V'));child.set(PDFName.of('DW2'),doc.context.obj([880,-1000]));child.set(PDFName.of('W2'),doc.context.obj(rows));
 return{ref:p.ref,font:readVerticalFont(raw,resource),name:face.name};
}
