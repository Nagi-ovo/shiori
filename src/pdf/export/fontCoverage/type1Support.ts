import { sha256 } from '@noble/hashes/sha2.js';
import type { RunRefusalCode } from '../contentStreamEdit/runRefusal';
export const stage5Type1 = Object.freeze({sourceReuse:true,standard14Afm:false});
export type Type1Options={sourceReuse?:boolean;standard14Afm?:boolean};
export type Type1Reason = 'type1-container-invalid'|'type1-eexec-invalid'|'type1-ps-unsupported'|'type1-charstring-invalid'|'type1-charstring-unsupported'|'type1-subr-invalid'|'type1-other-subr-unsupported'|'parser-budget-exceeded'|'glyph-unavailable'|'glyph-identity-conflict'|'font-metrics-missing'|'font-metrics-conflict'|'missing-tounicode'|'tounicode-malformed'|'unsupported-matrix'|'font-program-missing';
export type Type1Diagnostic={code:Type1Reason;detail:string;data?:Readonly<Record<string,string|number|boolean>>};
export class Type1Error extends Error {
  readonly diagnostic:Type1Diagnostic;
  constructor(code:Type1Reason,detail:string,data?:Type1Diagnostic['data']) {
    super(`${code}: ${detail}`);this.diagnostic={code,detail,data};
  }
}
export function rejectType1(code:Type1Reason,detail:string,data?:Type1Diagnostic['data']):never {throw new Type1Error(code,detail,data);}
export const type1Limits=Object.freeze({bytes:16*1024*1024,strings:65536,stringBytes:1024*1024,stack:24,depth:16,glyphOps:100000,fontOps:2000000,nesting:64,tokens:1000000});
export function type1Budget(parser:string,limit:string):never {return rejectType1('parser-budget-exceeded',`${parser}: ${limit}`,{parser,limit});}
export const type1Hash=(bytes:Uint8Array)=>Array.from(sha256(bytes),b=>b.toString(16).padStart(2,'0')).join('');
/** Stable compatibility mapping until the dispatcher extends the public union.
 * Identity conflicts and malformed source programs must never request fallback. */
export function type1RunDiagnostic(d:Type1Diagnostic):{code:RunRefusalCode;detail:string;terminal:boolean;diagnostic:Type1Diagnostic} {
  const code:RunRefusalCode=d.code==='unsupported-matrix'?'unsupported-matrix':d.code.startsWith('type1-')||d.code==='parser-budget-exceeded'?'font-coverage':'font-unavailable';
  return {code,detail:`${d.code}: ${d.detail}`,terminal:d.code!=='glyph-unavailable',diagnostic:d};
}
