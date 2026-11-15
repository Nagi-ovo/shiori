import { PDFArray, PDFDict, PDFDocument, PDFName, PDFStream } from 'pdf-lib';
import { collectFontCoverage, lookup, streamBytes } from '../../src/pdf/export/fontCoverage/pdfLibAdapter';
import type { PdfFontCoverage } from '../../src/pdf/export/fontCoverage/pdfLibAdapter';
import { codeHex, hexBytes } from '../../src/pdf/export/fontCoverage/types';
import { parseCMap } from '../../src/pdf/export/fontCoverage/cmap';
import { tokenizeContentStream, coalesceContentStreams } from '../../src/pdf/export/contentStreamEdit/tokenizer';
import { walkTextPlacements } from '../../src/pdf/export/contentStreamEdit/textState';
import type { ExpectedRow } from './expectations';

export type CheckedRow={page:number;path:string[];font:string;code:string;cluster?:string;status:'round-trip'|'rejected'|'FAILED';gid?:number;reason?:string};
type Unwalked={page:number;path:string[];reason:string};
/** Code widths belong to the rendering Encoding, not rejected ToUnicode keys. */
function codeWidth(font:PDFDict):1|2 {
  if(String(lookup(font,'Subtype'))!=='/Type0')return 1;
  const encoding=lookup(font,'Encoding');
  if(encoding instanceof PDFName && ['Identity-H','Identity-V'].includes(encoding.decodeText()))return 2;
  if(!(encoding instanceof PDFStream))throw new Error('unsupported predefined CMap');
  const parsed=parseCMap(new TextDecoder('latin1').decode(streamBytes(encoding)));
  const widths=new Set(parsed.codeSpaces.map(range=>range.low.length/2));
  if(!widths.size)for(const code of parsed.cids.keys())widths.add(code.length/2);
  if(parsed.identity)widths.add(2);
  if(widths.size!==1 || ![1,2].includes([...widths][0]!))throw new Error('walker cannot collect variable-width or >2-byte codes');
  return [...widths][0] as 1|2;
}
function mismatches(actual:CheckedRow[],expected:readonly ExpectedRow[]):string[] {
  const errors:string[]=[],remaining=[...actual];
  for(const row of expected) {
    const index=remaining.findIndex(check=>check.page===(row.page ?? 1) && check.font===(row.font ?? 'F1') && check.code===row.code && JSON.stringify(check.path)===JSON.stringify(row.path ?? []));
    if(index<0){errors.push(`missing expected row ${JSON.stringify(row)}`);continue;}
    const [check]=remaining.splice(index,1);
    if(check!.status!==row.status || check!.gid!==row.gid || (row.reasonContains && !check!.reason?.includes(row.reasonContains))) {
      errors.push(`expected ${JSON.stringify(row)}; got ${JSON.stringify(check)}`);
    }
  }
  for(const row of remaining)errors.push(`unexpected row ${JSON.stringify(row)}`);
  return errors;
}
/** Uses the existing walker for shows; independent literal rows/GIDs make
 * generated fixtures fail if encoding or glyph selection drifts. */
export function inspectCoverage(document:PDFDocument,expected?:readonly ExpectedRow[]) {
  const fonts=collectFontCoverage(document),checks:CheckedRow[]=[],unwalked:Unwalked[]=[];
  const scope=(resources:PDFDict|undefined,parts:Uint8Array[],page:number,path:string[],ancestors:Set<PDFStream>)=>{
    const matching=(font:PdfFontCoverage,name:string)=>font.resources.some(r=>r.page===page && r.name===name && JSON.stringify(r.path)===JSON.stringify(path));
    let ops;
    try {ops=tokenizeContentStream(coalesceContentStreams(parts));}
    catch(error){unwalked.push({page,path,reason:String(error)});return;}
    const walk=walkTextPlacements(ops,{resolveFont:name=>{
      const font=fonts.find(f=>matching(f,name));
      const dictionary=resources?lookup(resources,'Font'):undefined;
      const resolved=dictionary instanceof PDFDict?lookup(dictionary,name):undefined;
      if(!font || !(resolved instanceof PDFDict))return null;
      try {
        return {ok:true,bytesPerCode:codeWidth(resolved),widthOf:()=>0,ascentEm:1,descentEm:0,appliesWordSpacing:false};
      } catch(error){return {ok:false,reason:String(error)};}
    }});
    if(!walk.ok)unwalked.push({page,path,reason:walk.reason});
    else {
      if(walk.unplacedText)unwalked.push({page,path,reason:'text-state walker left text unplaced'});
      for(const glyph of walk.glyphs) {
        const font=fonts.find(f=>matching(f,glyph.fontName))!;
        const code=glyph.code.toString(16).padStart(glyph.byteLength*2,'0'),cluster=font.codeToUnicode.get(code);
        const mapped=cluster && font.encodable.get(cluster)?.some(c=>codeHex(c)===code);
        const row:CheckedRow={page,path,font:glyph.fontName,code,cluster,status:'rejected',gid:font.glyphIds.get(code)};
        if(!mapped)row.reason=font.missing.find(m=>m.code===code)?.reason ?? font.missing.find(m=>!m.code)?.reason ?? 'no Unicode mapping';
        else {
          const result=font.canEncode(cluster!,{preferredCodes:[hexBytes(code)]});
          row.status=result.ok && result.preferredApplied && result.codes.length===1 && codeHex(result.bytes)===code?'round-trip':'FAILED';
        }
        checks.push(row);
      }
    }
    // Failed walks discard their partial placements/XObjects. The tokenizer
    // still has every parsed Do, including Forms after the failing operator.
    for(const op of ops) {
      if(op.operator!=='Do' || op.operands.length!==1 || op.operands[0]?.kind!=='name')continue;
      const name=op.operands[0].value,objects=resources?lookup(resources,'XObject'):undefined;
      const form=objects instanceof PDFDict?lookup(objects,name):undefined;
      if(!(form instanceof PDFStream)){unwalked.push({page,path,reason:`unresolvable XObject ${name}`});continue;}
      if(String(lookup(form.dict,'Subtype'))!=='/Form' || ancestors.has(form))continue;
      const nested=lookup(form.dict,'Resources');
      scope(nested instanceof PDFDict?nested:resources,[streamBytes(form)],page,[...path,name],new Set([...ancestors,form]));
    }
  };
  for(const [i,page] of document.getPages().entries()) {
    const content=lookup(page.node,'Contents');
    const parts=content instanceof PDFArray?Array.from({length:content.size()},(_,j)=>streamBytes(content.lookup(j))):content?[streamBytes(content)]:[];
    scope(page.node.Resources(),parts,i+1,[],new Set());
  }
  const failedRoundTrips=checks.filter(row=>row.status==='FAILED').length;
  const expectationMismatches=expected?mismatches(checks,expected):[];
  return {fonts,checks,unwalked,shown:checks.length,verified:checks.filter(row=>row.status==='round-trip').length,
    rejected:checks.filter(row=>row.status==='rejected').length,failedRoundTrips,expectationMismatches,
    failures:failedRoundTrips+expectationMismatches.length+unwalked.length};
}
