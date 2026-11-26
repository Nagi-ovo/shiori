import { Type1Error, rejectType1 } from './type1Support';
import type { Type1Options } from './type1Support';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream } from 'pdf-lib';
import { createFontCoverage } from './coverage';
import type { FontCoverage, FontInput } from './types';
import type { Type3FontInput } from './type3Proof';
export type FontResource = {page:number;name:string;path:string[]};
export type PdfFontCoverage = FontCoverage & {objectRef:string|null;resources:FontResource[]};
export function lookup(dict:PDFDict,key:string):unknown {
  const raw=dict.get(PDFName.of(key));return raw instanceof PDFRef?dict.context.lookup(raw):raw;
}
const name=(v:unknown):string|undefined=>v instanceof PDFName?v.decodeText():undefined;
export function streamBytes(stream:unknown):Uint8Array {
  if(stream instanceof PDFRawStream)return stream.dict.has(PDFName.of('Filter'))?decodePDFRawStream(stream).decode():stream.getContents();
  if(stream instanceof PDFStream)return stream.getContents();
  throw new Error('expected PDF stream');
}
const streamText=(v:unknown):string=>Array.from(streamBytes(v),b=>String.fromCharCode(b)).join('');
export function readFontEncoding(font:PDFDict):FontInput['encoding'] {
  const enc=lookup(font,'Encoding');
  if(enc===undefined)return undefined;
  if(enc instanceof PDFName)return enc.decodeText();
  if(enc instanceof PDFStream) {
    if(enc.dict.has(PDFName.of('UseCMap')))throw new Error('unsupported CMap stream UseCMap');
    return {cmap:streamText(enc)};
  }
  if(!(enc instanceof PDFDict))throw new Error('malformed Encoding');
  const differences:Record<number,string>={},diff=lookup(enc,'Differences');
  let code:number|undefined;
  if(diff!==undefined && !(diff instanceof PDFArray))throw new Error('malformed Differences');
  if(diff instanceof PDFArray)for(let i=0;i<diff.size();i++) {
    const value=diff.lookup(i);
    if(value instanceof PDFNumber)code=value.asNumber();
    else if(value instanceof PDFName && code!==undefined)differences[code++]=value.decodeText();
    else throw new Error('malformed Differences entry');
  }
  return {base:name(lookup(enc,'BaseEncoding')),differences};
}
export function fontInputFromDict(font:PDFDict):Type3FontInput {
  const input:Type3FontInput={subtype:name(lookup(font,'Subtype')) ?? '(missing)',baseFont:name(lookup(font,'BaseFont'))};
  try {
    input.encoding=readFontEncoding(font);
    const unicode=lookup(font,'ToUnicode');
    if(unicode!==undefined) {
      if(unicode instanceof PDFStream && unicode.dict.has(PDFName.of('UseCMap')))throw new Error('unsupported ToUnicode UseCMap');
      input.toUnicode=streamText(unicode);
    }
    let actual=font;
    if(input.subtype==='Type0') {
      const children=lookup(font,'DescendantFonts');
      if(!(children instanceof PDFArray) || children.size()!==1 || !(children.lookup(0) instanceof PDFDict))throw new Error('malformed DescendantFonts');
      actual=children.lookup(0) as PDFDict;input.cidSubtype=name(lookup(actual,'Subtype'));
      const map=lookup(actual,'CIDToGIDMap');
      if(map!==undefined) {
        if(map instanceof PDFName && map.decodeText()==='Identity')input.cidToGid='Identity';
        else input.cidToGid=streamBytes(map);
      }
    }
    const numeric=(dict:PDFDict,key:string):number|undefined=>{
      const raw=lookup(dict,key);if(raw===undefined)return;
      if(!(raw instanceof PDFNumber)){if(['Length1','Length2','Length3'].includes(key))rejectType1('type1-container-invalid',`malformed /${key}`);throw new Error(`font-resource-invalid: malformed /${key}`);}return raw.asNumber();
    };
    const numbers=(key:string):number[]|undefined=>{
      const raw=lookup(actual,key);if(raw===undefined)return;
      if(!(raw instanceof PDFArray))throw new Error(`font-resource-invalid: malformed /${key}`);
      return Array.from({length:raw.size()},(_,i)=>{const n=raw.lookup(i);if(!(n instanceof PDFNumber))throw new Error(`font-resource-invalid: malformed /${key}`);return n.asNumber();});
    };
    input.fontMatrix=numbers('FontMatrix');input.fontBBox=numbers('FontBBox');
    input.firstChar=numeric(actual,'FirstChar');input.lastChar=numeric(actual,'LastChar');input.widths=numbers('Widths');
    const descriptor=lookup(actual,'FontDescriptor');
    if(descriptor instanceof PDFDict) {
      const flags=lookup(descriptor,'Flags');if(flags instanceof PDFNumber)input.flags=flags.asNumber();
      for(const key of ['FontFile2','FontFile3','FontFile']) {
        const stream=lookup(descriptor,key);
        if(stream!==undefined){
          input.program=streamBytes(stream);input.programKind=key;
          if(key==='FontFile'){
            if(!(stream instanceof PDFStream))throw new Error('type1-container-invalid: FontFile is not a stream');
            input.length1=numeric(stream.dict,'Length1');input.length2=numeric(stream.dict,'Length2');input.length3=numeric(stream.dict,'Length3');
          }
          break;
        }
      }
    }
    const procs=lookup(font,'CharProcs');
    if(procs instanceof PDFDict)input.charProcs=procs.entries().filter(([,v])=>{
      const resolved=v instanceof PDFRef?font.context.lookup(v):v;return resolved instanceof PDFStream;
    }).map(([k])=>k.decodeText());
    if(input.subtype==='Type3' && procs instanceof PDFDict) {
      input.type3CharProcs=Object.fromEntries(procs.entries().flatMap(([key,raw])=>{
        const proc=raw instanceof PDFRef?font.context.lookup(raw):raw;
        return proc instanceof PDFStream?[[key.decodeText(),streamBytes(proc)]]:[];
      }));
    }
  } catch(error) {input.error=error instanceof Error?error.message:String(error);if(error instanceof Type1Error)input.diagnostic=error.diagnostic;}
  return input;
}
export function fontCoverageFromDict(font:PDFDict,options:Type1Options={}):FontCoverage {
  return createFontCoverage(fontInputFromDict(font),options);
}
/** Resource identity is PDF object identity, never BaseFont. Pages are 1-based;
 * path identifies nested Form resource scopes. Cycles are visited once per path. */
export function collectFontCoverage(document:PDFDocument):PdfFontCoverage[] {
  const reports:PdfFontCoverage[]=[],seen=new Map<PDFDict,PdfFontCoverage>();
  const visit=(resources:unknown,page:number,path:string[],ancestors:Set<PDFStream>)=>{
    if(!(resources instanceof PDFDict))return;
    const fonts=lookup(resources,'Font');
    if(fonts instanceof PDFDict)for(const [key,raw] of fonts.entries()) {
      const font=raw instanceof PDFRef?document.context.lookup(raw):raw;
      if(!(font instanceof PDFDict))continue;
      let report=seen.get(font);
      if(!report){report={...fontCoverageFromDict(font),objectRef:raw instanceof PDFRef?raw.toString():null,resources:[]};seen.set(font,report);reports.push(report);}
      report.resources.push({page,name:key.decodeText(),path:[...path]});
    }
    const objects=lookup(resources,'XObject');
    if(objects instanceof PDFDict)for(const [key,raw] of objects.entries()) {
      const form=raw instanceof PDFRef?document.context.lookup(raw):raw;
      if(!(form instanceof PDFStream) || name(lookup(form.dict,'Subtype'))!=='Form' || ancestors.has(form))continue;
      visit(lookup(form.dict,'Resources') ?? resources,page,[...path,key.decodeText()],new Set([...ancestors,form]));
    }
  };
  document.getPages().forEach((page,i)=>visit(page.node.Resources(),i+1,[],new Set()));
  return reports;
}
