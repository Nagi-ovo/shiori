import {PDFArray,PDFDict,PDFName,PDFNumber,PDFRawStream,PDFRef,decodePDFRawStream,type PDFPage} from 'pdf-lib';
import {contentFontInfo} from './glyphWidths';
import {resolveRunFonts} from './replaceRunPage';
import {runToUnicode} from './runToUnicode';
import {fontInputFromDict,fontCoverageFromDict} from '../fontCoverage/pdfLibAdapter';
import {simpleNames,glyphUnicode} from '../fontCoverage/encodings';
import type {ResolvedRunFont} from './replaceRun';

const number=(d:PDFDict,k:string)=>d.lookupMaybe(PDFName.of(k),PDFNumber)?.asNumber();
const array=(d:PDFDict,k:string)=>d.lookupMaybe(PDFName.of(k),PDFArray)?.asArray().map(v=>{
 const n=d.context.lookup(v);return n instanceof PDFNumber?n.asNumber():NaN;
});
export type SubstituteSourceFont=ResolvedRunFont&{base:string;flags:number;sourceBox?:readonly number[]};
/** Placement needs source code boundaries and PDF advances, not reusable
 * outlines. Never feed these intentionally non-reusable fonts to normal edits. */
export function substituteSourceFonts(page:PDFPage):SubstituteSourceFont[]{
 const fonts=page.node.Resources()?.lookupMaybe(PDFName.of('Font'),PDFDict),resolved=resolveRunFonts(page,{sourceReuse:false});
 return (fonts?.entries()??[]).flatMap(([key,ref])=>{
  const dict=fonts!.context.lookup(ref);if(!(dict instanceof PDFDict)||!(ref instanceof PDFRef))return [];
  const subtype=dict.lookupMaybe(PDFName.of('Subtype'),PDFName)?.decodeText();
  const child=dict.lookupMaybe(PDFName.of('DescendantFonts'),PDFArray)?.lookup(0,PDFDict);
  if(dict.has(PDFName.of('WMode'))||child?.has(PDFName.of('WMode')))return [];
  const input=fontInputFromDict(dict),matrix=array(dict,'FontMatrix');
  if(matrix&&(matrix.length!==6||matrix.some((n,i)=>!Number.isFinite(n)||Math.abs(n-[.001,0,0,.001,0,0][i]!)>1e-10)))return [];
  if(subtype==='Type1'&&input.program){
   if(/\/WMode\b/u.test(new TextDecoder('latin1').decode(input.program)))return [];
   if(fontCoverageFromDict(dict).failures?.some(d=>d.code==='unsupported-matrix'))return [];
  }
  const descriptor=(child??dict).lookupMaybe(PDFName.of('FontDescriptor'),PDFDict);
  let info=resolved.find(f=>f.resourceName===key.decodeText()),sourceBox:readonly number[]|undefined;
  if(subtype==='Type3'){
   const matrix=array(dict,'FontMatrix'),box=array(dict,'FontBBox');
   if(!matrix||matrix.length!==6||matrix.some((n,i)=>Math.abs(n-[.001,0,0,.001,0,0][i]!)>1e-10)||
    !box||box.length!==4||!box.every(Number.isFinite)||box[3]!<=box[1]!||box[2]!<box[0]!)return [];
   const horizontal=dict.clone();horizontal.set(PDFName.of('Subtype'),PDFName.of('TrueType'));
   const metrics=contentFontInfo(horizontal);if(!metrics.ok)return [];
   info={...metrics,ascentEm:Math.max(.4,box[3]!/1000),descentEm:Math.min(0,box[1]!/1000),resourceName:key.decodeText(),objectId:ref.toString(),unicodeByCode:new Map()};
   sourceBox=box;
  }
  if(!info)return [];
  // Missing explicit simple widths must stay unknown; never infer them from
  // the substitute font or a family name. Out-of-range codes are unknown too.
  const widths=array(dict,'Widths'),first=number(dict,'FirstChar');
  if(info.bytesPerCode===1&&(!widths||first===undefined))return [];
  const widthOf=info.bytesPerCode===1?(code:number)=>widths![code-first!]??NaN:info.widthOf;
  const raw=dict.lookup(PDFName.of('ToUnicode'));
  let mapping:ReadonlyMap<number,string>|null=info.unicodeByCode;
  if(raw instanceof PDFRawStream)mapping=runToUnicode(new TextDecoder('latin1').decode(raw.dict.has(PDFName.of('Filter'))?decodePDFRawStream(raw).decode():raw.getContents()),info.bytesPerCode);
  else if(info.bytesPerCode===1){
   // An explicit known Encoding supplies source labels even when the font
   // program is unusable. No source glyph is reused based on these labels.
   if(input.error||!input.encoding)return [];
   try{mapping=new Map([...simpleNames(input)].flatMap(([code,name])=>{const text=glyphUnicode(name);return text?[[code,text]as const]:[];}));}catch{return [];}
  }
  if(!mapping?.size)return [];
  return [{...info,widthOf,unicodeByCode:mapping,sourceBox,base:dict.lookupMaybe(PDFName.of('BaseFont'),PDFName)?.decodeText()??'',flags:number(descriptor??dict,'Flags')??0,
   assertSource:undefined,canEncode:(text:string)=>({ok:false as const,reason:'whole-run substitution',firstMissing:text,offset:0})}];
 });
}
