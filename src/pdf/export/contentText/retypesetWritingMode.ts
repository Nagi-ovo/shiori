import {PDFArray,PDFDict,PDFName,PDFNumber,PDFStream,type PDFPage} from 'pdf-lib';
import {type1Container} from '../fontCoverage/type1Container';
import {Type1Lexer} from '../fontCoverage/type1Lexer';
import {fontInputFromDict,streamBytes} from '../fontCoverage/pdfLibAdapter';
import {parseCMap} from '../fontCoverage/cmap';

/** Detection only. The approximate layout compiler emits horizontal shows;
 * WMode 1 must remain unsupported here, with no vert/vrt2 substitution. */
export function verticalRetypesetFonts(page:PDFPage){
 const result=new Set<string>(),fonts=page.node.Resources()?.lookupMaybe(PDFName.of('Font'),PDFDict);
 const wmode=(dict:PDFDict)=>{const value=dict.lookup(PDFName.of('WMode'));return value instanceof PDFNumber&&value.asNumber()===1;};
 for(const [name,value]of fonts?.entries()??[]){
  const raw=fonts!.context.lookup(value);if(!(raw instanceof PDFDict))continue;
  const child=raw.lookupMaybe(PDFName.of('DescendantFonts'),PDFArray)?.lookup(0,PDFDict),enc=raw.lookup(PDFName.of('Encoding'));
  const input=fontInputFromDict(raw);
  if(input.subtype==='Type1'&&input.program)try{
   const lexer=new Type1Lexer(type1Container(input).clear);
   for(let t=lexer.next();t;t=lexer.next())if(t.kind==='name'&&t.value==='WMode'){
    const value=lexer.next(),def=lexer.next();
    if(value?.kind==='number'&&+value.value===1&&def?.value==='def')result.add(name.decodeText());
   }
  }catch{ /* Unsupported programs retain the existing source-font refusal. */ }
  let vertical=enc instanceof PDFStream&&wmode(enc.dict);
  if(enc instanceof PDFStream)try{vertical ||= parseCMap(new TextDecoder('latin1').decode(streamBytes(enc))).vertical;}catch{ /* Existing CMap resolver owns malformed maps. */ }
  if(wmode(raw)||child&&wmode(child)||enc===PDFName.of('Identity-V')||vertical)result.add(name.decodeText());
 }
 return result;
}
