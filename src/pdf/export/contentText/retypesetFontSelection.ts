import fontkit from '@pdf-lib/fontkit';
import {PDFArray,PDFDict,PDFName,PDFNumber,PDFString,PDFHexString,type PDFPage} from 'pdf-lib';
import {fallbackFontName,type FallbackOptions} from '../contentStreamEdit/fallbackFont';
import {fallbackClusters} from '../contentStreamEdit/fallbackClusters';
import {loadBundledFallbackFont} from '../contentStreamEdit/fallbackAssets';
import {RunCompileError} from '../contentStreamEdit/runRefusal';

/** Read the original resource, including a Type0 descendant's descriptor.
 * FontName/FontFamily can retain style hints absent from a subset BaseFont. */
export function originalFallbackFace(page:PDFPage,resource:string,text:string){
 const font=page.node.Resources()?.lookupMaybe(PDFName.of('Font'),PDFDict)?.lookupMaybe(PDFName.of(resource),PDFDict);
 const child=font?.lookupMaybe(PDFName.of('DescendantFonts'),PDFArray)?.lookup(0,PDFDict);
 const descriptor=(child??font)?.lookupMaybe(PDFName.of('FontDescriptor'),PDFDict);
 const hints=[font?.get(PDFName.of('BaseFont')),child?.get(PDFName.of('BaseFont')),descriptor?.get(PDFName.of('FontName')),descriptor?.get(PDFName.of('FontFamily'))]
  .map(v=>v?font!.context.lookup(v):undefined).flatMap(v=>v instanceof PDFName||v instanceof PDFString||v instanceof PDFHexString?[v.decodeText()]:[]).join(' ');
 const number=(key:string)=>descriptor?.lookupMaybe(PDFName.of(key),PDFNumber)?.asNumber();
 return fallbackFontName(hints||resource,number('Flags')??0,text,number('FontWeight')??400);
}

/** Inspect cmap coverage before embedding. First prefer one face covering all
 * missing output; if none does, retain the writer's existing per-cluster font
 * machinery. A paragraph containing CJK never admits a Liberation candidate.
 * Original encodable clusters remain in their source fonts. */
export function retypesetFontSelector(options:FallbackOptions){
 const loaded=new Map<string,Promise<{data:Uint8Array;parsed:ReturnType<typeof fontkit.create>}>>();
 const load=(name:string)=>{
  let pending=loaded.get(name);
  if(!pending){pending=(options.loadFont??loadBundledFallbackFont)(name).then(data=>({data,parsed:fontkit.create(data)}));loaded.set(name,pending);}
  return pending;
 };
 return async(primary:string,paragraph:string,clusters:readonly string[])=>{
  const cjk=/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(paragraph);
  const names=[...new Set([primary,...(cjk?['NotoSansJP-Regular.otf','NotoSansSC-Regular.otf','NotoSansKR-Regular.otf']:[]),
   'NotoSansMath-Regular.ttf','NotoSansSymbols2-Regular.ttf',...(!cjk?['NotoSansSC-Regular.otf','NotoSansJP-Regular.otf','NotoSansKR-Regular.otf']:[])])]
   .filter(n=>!cjk||!n.startsWith('Liberation'));
  const needed=[...new Set(clusters.flatMap(fallbackClusters))];
  const candidates=[];
  for(const name of names){
   const {data,parsed}=await load(name);
   const covers=(cluster:string)=>Array.from(cluster.normalize('NFC')).every(c=>parsed.glyphForCodePoint(c.codePointAt(0)!).id!==0);
   const candidate={name,data,clusters:needed.filter(covers)};candidates.push(candidate);
   if(candidate.clusters.length===needed.length)return [candidate];
  }
  const remaining=new Set(needed),groups=[];
  for(const candidate of candidates){
   const assigned=candidate.clusters.filter(c=>remaining.has(c));
   if(assigned.length){groups.push({...candidate,clusters:assigned});for(const c of assigned)remaining.delete(c);}
  }
  if(remaining.size)throw new RunCompileError(`unsupported fallback missing glyph after coverage chain: ${[...remaining].join(' ')}`,'font-coverage');
  return groups;
 };
}
