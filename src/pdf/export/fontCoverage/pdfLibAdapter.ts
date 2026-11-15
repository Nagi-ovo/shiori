import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream } from 'pdf-lib';
import { createFontCoverage } from './coverage';
import type { FontCoverage, FontInput } from './types';
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
function encoding(font:PDFDict):FontInput['encoding'] {
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
export function fontCoverageFromDict(font:PDFDict):FontCoverage {
  const input:FontInput={subtype:name(lookup(font,'Subtype')) ?? '(missing)',baseFont:name(lookup(font,'BaseFont'))};
  try {
    input.encoding=encoding(font);
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
    const descriptor=lookup(actual,'FontDescriptor');
    if(descriptor instanceof PDFDict) {
      const flags=lookup(descriptor,'Flags');if(flags instanceof PDFNumber)input.flags=flags.asNumber();
      for(const key of ['FontFile2','FontFile3','FontFile']) {
        const stream=lookup(descriptor,key);
        if(stream!==undefined){input.program=streamBytes(stream);input.programKind=key;break;}
      }
    }
    const procs=lookup(font,'CharProcs');
    if(procs instanceof PDFDict)input.charProcs=procs.entries().filter(([,v])=>{
      const resolved=v instanceof PDFRef?font.context.lookup(v):v;return resolved instanceof PDFStream;
    }).map(([k])=>k.decodeText());
  } catch(error) {input.error=error instanceof Error?error.message:String(error);}
  return createFontCoverage(input);
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
