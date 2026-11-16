import {PDFArray,PDFDict,PDFName,PDFNumber,PDFStream} from 'pdf-lib';
import {streamBytes} from '../fontCoverage/pdfLibAdapter';

/** Detection only. Vertical CIDs are never interpreted as Unicode or passed
 * to the horizontal writer. Emission would require Identity-V, vert (without
 * stacking vrt2), and DW2/W2 from vmtx/VORG; this milestone refuses instead. */
export function verticalWritingReason(font:PDFDict):string|undefined{
 const wmode=(d:PDFDict)=>d.lookupMaybe(PDFName.of('WMode'),PDFNumber)?.asNumber()===1;
 const child=font.lookupMaybe(PDFName.of('DescendantFonts'),PDFArray)?.lookup(0,PDFDict);
 if(wmode(font)||(child&&wmode(child)))return 'unsupported-vertical-writing: font WMode 1';
 const seen=new Set<PDFStream>();
 const encoding=(value:unknown):string|undefined=>{
  if(value instanceof PDFName)return /(?:^|-)V$/u.test(value.decodeText())?`unsupported-vertical-writing: /${value.decodeText()}`:undefined;
  if(!(value instanceof PDFStream)||seen.has(value))return;
  seen.add(value);
  if(wmode(value.dict))return 'unsupported-vertical-writing: encoding CMap WMode 1';
  const inherited=encoding(value.dict.lookup(PDFName.of('UseCMap')));if(inherited)return inherited;
  // Ignore comments and literal strings; /WMode may span line breaks. Named
  // vertical usecmap is enough to refuse even when its mapping is unsupported.
  const tokens=new TextDecoder('latin1').decode(streamBytes(value)).match(/%[^\r\n]*|\((?:\\.|[^\\)])*\)|[^\s()]+/gu)?.filter(t=>!t.startsWith('%')&&!t.startsWith('('))??[];
  for(let i=0;i<tokens.length;i++){
   if(tokens[i]==='/WMode'&&tokens[i+1]==='1'&&tokens[i+2]==='def')return 'unsupported-vertical-writing: encoding CMap /WMode 1 def';
   if(tokens[i]==='usecmap'&&/^\/.*-V$/u.test(tokens[i-1]??''))return `unsupported-vertical-writing: ${tokens[i-1]} usecmap`;
  }
 };
 return encoding(font.lookup(PDFName.of('Encoding')));
}
