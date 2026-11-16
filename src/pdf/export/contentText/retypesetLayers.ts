import {PDFDict,PDFName,PDFRawStream,PDFArray,PDFNumber,decodePDFRawStream,type PDFPage} from 'pdf-lib';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import type {PdfRect} from '../../model/types';
/** Form streams remain read-only in M1. Distinguish real form text from a
 * vector-only form so graphic-only pages still report no text layer. */
function formNamesWith(page:PDFPage,kind:'text'|'image'):Set<string>{
 const seen=new Set<PDFRawStream>();
 const hasText=(raw:PDFRawStream):boolean=>{
  if(seen.has(raw))return false;seen.add(raw);
  try{
   const bytes=raw.dict.has(PDFName.of('Filter'))?decodePDFRawStream(raw).decode():raw.getContents(),ops=tokenizeContentStream(bytes);
   if(ops.some(o=>kind==='text'?['Tj','TJ',"'",'"'].includes(o.operator):o.operator==='BI'))return true;
   const objects=raw.dict.lookupMaybe(PDFName.of('Resources'),PDFDict)?.lookupMaybe(PDFName.of('XObject'),PDFDict);
   return ops.some(o=>{
    if(o.operator!=='Do'||o.operands[0]?.kind!=='name')return false;
    const child=objects?.lookup(PDFName.of(o.operands[0].value));
    if(!(child instanceof PDFRawStream))return false;
    const subtype=child.dict.lookupMaybe(PDFName.of('Subtype'),PDFName)?.decodeText();
    return kind==='image'&&subtype==='Image'||subtype==='Form'&&hasText(child);
   });
  }catch{return true;}
 };
 const dict=page.node.Resources()?.lookupMaybe(PDFName.of('XObject'),PDFDict),result=new Set<string>();
 for(const [name,ref]of dict?.entries()??[]){
  const raw=dict!.context.lookup(ref);seen.clear();
  if(raw instanceof PDFRawStream&&raw.dict.lookupMaybe(PDFName.of('Subtype'),PDFName)?.decodeText()==='Form'&&hasText(raw))result.add(name.decodeText());
 }
 return result;
}
export const textFormNames=(page:PDFPage)=>formNamesWith(page,'text');
export const imageFormNames=(page:PDFPage)=>formNamesWith(page,'image');
export function imageOverlaps(ctm:readonly number[],rects:readonly PdfRect[],box:readonly number[]=[0,0,1,1]){
 const points=[[box[0],box[1]],[box[2],box[1]],[box[0],box[3]],[box[2],box[3]]].map(([x,y])=>({x:ctm[0]!*x!+ctm[2]!*y!+ctm[4]!,y:ctm[1]!*x!+ctm[3]!*y!+ctm[5]!}));
 const x=Math.min(...points.map(p=>p.x)),y=Math.min(...points.map(p=>p.y)),right=Math.max(...points.map(p=>p.x)),top=Math.max(...points.map(p=>p.y));
 return rects.some(r=>x<r.x+r.w&&right>r.x&&y<r.y+r.h&&top>r.y);
}
/** A form's bounds conservatively contain its nested images. Uncertain
 * bounds must never authorize drawing visible replacement text on a scan. */
export function formImageOverlaps(page:PDFPage,name:string,ctm:readonly number[],rects:readonly PdfRect[]){
 const raw=page.node.Resources()?.lookupMaybe(PDFName.of('XObject'),PDFDict)?.lookup(PDFName.of(name));
 if(!(raw instanceof PDFRawStream))return true;
 const numbers=(key:string)=>raw.dict.lookupMaybe(PDFName.of(key),PDFArray)?.asArray().map(n=>{const value=raw.dict.context.lookup(n);return value instanceof PDFNumber?value.asNumber():NaN;});
 const box=numbers('BBox'),m=numbers('Matrix')??[1,0,0,1,0,0];
 if(!box||box.length!==4||m.length!==6||![...box,...m].every(Number.isFinite))return true;
 const a=ctm,c=m,combined=[a[0]!*c[0]!+a[2]!*c[1]!,a[1]!*c[0]!+a[3]!*c[1]!,a[0]!*c[2]!+a[2]!*c[3]!,a[1]!*c[2]!+a[3]!*c[3]!,a[0]!*c[4]!+a[2]!*c[5]!+a[4]!,a[1]!*c[4]!+a[3]!*c[5]!+a[5]!];
 return imageOverlaps(combined,rects,box);
}
