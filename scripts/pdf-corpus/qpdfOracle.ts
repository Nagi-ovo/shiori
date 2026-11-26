import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PDFDocument,PDFName,PDFRawStream,PDFRef} from 'pdf-lib';

type QpdfCheck={status:number|null;issues:readonly string[]};
const rank=(status:number|null)=>{
 assert(status===0||status===3||status===2,`qpdf: abnormal exit ${status}`);
 return status===2?2:status===3?1:0;
};

/** Diagnostics form a multiset: six inherited warnings cannot excuse seven.
 * Exit 2 means errors and is worse than exit 3 (warnings), despite its value. */
export function compareQpdfChecks(before:QpdfCheck,after:QpdfCheck){
 const sourceRank=rank(before.status),outputRank=rank(after.status);
 assert(outputRank<=sourceRank,`qpdf: worse exit (${before.status} -> ${after.status})`);
 const available=new Map<string,number>();
 for(const issue of before.issues)available.set(issue,(available.get(issue)??0)+1);
 for(const issue of after.issues){
  const count=available.get(issue)??0;assert(count>0,`qpdf: new after-only diagnostic: ${issue}`);
  available.set(issue,count-1);
 }
 assert(!outputRank||after.issues.length,'qpdf: nonzero exit without accounted diagnostics');
 return {qpdf:'clean' as const,...(before.issues.length?{qpdfSourceIssues:before.issues.length,qpdfInheritedIssues:after.issues.length}:{})};
}

async function check(path:string):Promise<QpdfCheck>{
 const result=spawnSync('qpdf',['--check',path],{encoding:'utf8'});
 assert(!result.error,`qpdf: ${result.error}`);rank(result.status);
 const bytes=await readFile(path),doc=await PDFDocument.load(bytes);
 const streams=doc.context.enumerateIndirectObjects().flatMap(([,value])=>value instanceof PDFRawStream?[value]:[]);
 const fingerprint=(stream:PDFRawStream)=>createHash('sha256')
  .update(stream.getContents()).update(stream.dict.get(PDFName.of('Filter'))?.toString()??'')
  .update(stream.dict.get(PDFName.of('DecodeParms'))?.toString()??'').digest('hex');
 function normalize(line:string){
  const message=line.split(path).join('<pdf>');
  // Only relocations of the *same encoded stream* are equivalent. Blindly
  // deleting every offset/object id could hide a new problem of the same kind
  // in another object when an old warning disappears. Other locations remain
  // literal (conservative), and diagnostic payload numbers are never erased.
  return message.replace(/\((?:object (\d+) (\d+),? )?offset (\d+)\)|\(object (\d+) (\d+)\)/g,(location,object,generation,offset,objectOnly,generationOnly)=>{
   let stream:PDFRawStream|undefined;
   if(offset!==undefined){
    const start=Number(offset);
    stream=streams.find(s=>s.getContents().length>0&&bytes.subarray(start,start+s.getContents().length).equals(s.getContents()));
   }else{
    const value=doc.context.lookup(PDFRef.of(Number(objectOnly??object),Number(generationOnly??generation)));
    if(value instanceof PDFRawStream)stream=value;
   }
   return stream?`(stream sha256:${fingerprint(stream)})`:location;
  });
 }
 const lines=`${result.stdout}\n${result.stderr}`.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
 const info=new Set([`checking ${path}`,'File is not encrypted','File is encrypted','File is not linearized','File is linearized',
  'No syntax or stream encoding errors found; the file may still contain','errors that qpdf cannot detect','qpdf: operation succeeded with warnings']);
 const issues=lines.filter(line=>!info.has(line)&&!/^PDF Version: \d+\.\d+$/.test(line)).map(normalize);
 return {status:result.status,issues};
}

export async function auditQpdfPair(beforePath:string,afterPath:string){
 const before=await check(beforePath),after=await check(afterPath);
 return compareQpdfChecks(before,after);
}
