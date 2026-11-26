import {createHash} from 'node:crypto';
import {PDFArray,PDFDict,PDFName,PDFRawStream,decodePDFRawStream,type PDFPage} from 'pdf-lib';

type NativeGlyph={text:string;origin:readonly number[];box?:readonly number[];fontHash?:string};
const compact=(s:string)=>s.replace(/\s/gu,'');

/** Writing mode per embedded font program among the page's Type0 fonts,
 * keyed like PDFium's font hash: the decoded font file. A program also shown
 * by a horizontal resource is mixed and vouches for no column. */
function programModes(page:PDFPage){
 const modes=new Map<string,Set<string>>(),fonts=page.node.Resources()?.lookupMaybe(PDFName.of('Font'),PDFDict);
 for(const key of fonts?.keys()??[]){
  const font=fonts!.lookupMaybe(key,PDFDict);if(font?.get(PDFName.of('Subtype'))!==PDFName.of('Type0'))continue;
  const encoding=font.get(PDFName.of('Encoding')),mode=encoding instanceof PDFName?encoding.decodeText():'embedded-cmap';
  const descriptor=font.lookupMaybe(PDFName.of('DescendantFonts'),PDFArray)?.lookupMaybe(0,PDFDict)?.lookupMaybe(PDFName.of('FontDescriptor'),PDFDict);
  for(const file of ['FontFile','FontFile2','FontFile3']){
   const raw=descriptor?.lookup(PDFName.of(file));if(!(raw instanceof PDFRawStream))continue;
   const data=raw.dict.has(PDFName.of('Filter'))?decodePDFRawStream(raw).decode():raw.getContents(),hash=createHash('sha256').update(data).digest('hex');
   if(!modes.has(hash))modes.set(hash,new Set());modes.get(hash)!.add(mode);
  }
 }
 return modes;
}

/** A short upright column read from saved native glyphs and the source font
 * dictionaries alone, never from the writer's plan: at least two cells of one
 * embedded program that the page shows only through Identity-V, at one x,
 * each cell one native cell height below the last (no row skipped), and no
 * other ink nearer than 1.3 pitches on any selected row. Ownership is exactly
 * those cells; TCY runs or other text around them stay untargeted. */
export function identityVColumnOwnership(page:PDFPage,glyphs:readonly NativeGlyph[],native:readonly NativeGlyph[]){
 if(glyphs.length<2)return;
 const hash=glyphs[0]!.fontHash,modes=hash?programModes(page).get(hash):undefined;
 if(!hash||glyphs.some(g=>g.fontHash!==hash)||modes?.size!==1||!modes.has('Identity-V'))return;
 const x=glyphs[0]!.origin[0]!,pitch=glyphs[0]!.origin[1]!-glyphs[1]!.origin[1]!;
 if(!(pitch>0))return;
 const near=(a:number,b:number)=>Math.abs(a-b)<=pitch*.03;
 for(let i=0;i<glyphs.length;i++){
  const g=glyphs[i]!,b=g.box;
  if(!b||!near(b[3]!-b[1]!,pitch)||Math.abs(g.origin[0]!-x)>.01)return;
  if(i>0&&!near(glyphs[i-1]!.origin[1]!-g.origin[1]!,pitch))return;
 }
 const ink=native.filter(g=>compact(g.text)&&!glyphs.includes(g));
 if(glyphs.some(g=>ink.some(o=>Math.abs(o.origin[1]!-g.origin[1]!)<pitch*.5&&Math.abs(o.origin[0]!-g.origin[0]!)<pitch*1.3)))return;
 return Object.assign(glyphs.map(g=>({origin:[g.origin[0]!,g.origin[1]!],text:g.text})),{pitch});
}
