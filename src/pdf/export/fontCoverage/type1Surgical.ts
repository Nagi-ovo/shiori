import {RunCompileError} from '../contentStreamEdit/runRefusal';
import {type1RunDiagnostic} from './type1Support';
import type {Type1Diagnostic} from './type1Support';
import {codeHex} from './types';
import type {FontCoverage,EncodeOptions,EncodeResult} from './types';
function refuse(d:Type1Diagnostic):never {
  const mapped=type1RunDiagnostic(d);
  throw Object.assign(new RunCompileError(mapped.detail,mapped.code),{diagnostic:d,terminal:mapped.terminal});
}
/** Dispatcher must call this on EVERY addressed source code before compiler
 * permutation or fallback. Original ToUnicode labels remain untouched. */
export function assertType1Source(report:FontCoverage,codes:readonly Uint8Array[]):void {
  if(report.replacementDisabled)throw new RunCompileError(report.replacementDisabled,'font-unavailable');
  const global=report.failures?.find(d=>!d.hex);if(global)refuse(global);
  for(const bytes of codes){
    const hex=codeHex(bytes),failure=report.failures?.find(d=>d.hex===hex);
    if(failure)refuse(failure);
    if(!report.mappings?.has(hex))refuse({code:'glyph-unavailable',detail:`unproven addressed source code ${hex}`});
  }
}
/** Inject this as ResolvedRunFont.canEncode. Terminal failures throw so the
 * existing compiler cannot silently retry them with a fallback resource. */
export function surgicalType1Encoder(report:FontCoverage):(text:string,options?:EncodeOptions)=>EncodeResult {
  return (text,options)=>{
    const result=report.canEncode(text,options);
    if(!result.ok&&result.terminal&&result.code)refuse({code:result.code,detail:result.detail??result.reason,data:result.data});
    return result;
  };
}
