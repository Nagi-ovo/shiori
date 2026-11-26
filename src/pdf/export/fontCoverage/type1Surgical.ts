import {RunCompileError} from '../contentStreamEdit/runRefusal';
import {type1RunDiagnostic} from './type1Support';
import type {Type1Diagnostic} from './type1Support';
import {codeHex} from './types';
import type {FontCoverage,EncodeOptions,EncodeResult} from './types';
function refuse(d:Type1Diagnostic):never {
  const mapped=type1RunDiagnostic(d);
  throw Object.assign(new RunCompileError(mapped.detail,mapped.code),{diagnostic:d,terminal:mapped.terminal});
}
/** Call this for every addressed source code before compiler
 * permutation or fallback. Original ToUnicode labels remain untouched. */
export function assertType1Source(report:FontCoverage,codes:readonly Uint8Array[]):void {
  if(report.replacementDisabled)throw new RunCompileError(report.replacementDisabled,'font-unavailable');
  const global=report.failures?.find(d=>!d.hex);if(global)refuse(global);
  let unavailable:Type1Diagnostic|undefined;
  for(const bytes of codes){
    const hex=codeHex(bytes),failure=report.failures?.find(d=>d.hex===hex);
    if(failure&&failure.code!=='glyph-unavailable')refuse(failure);
    if(failure)unavailable??=failure;
    else if(!report.mappings?.has(hex))unavailable??={code:'glyph-unavailable',detail:`unproven addressed source code ${hex}`};
  }
  if(unavailable)refuse(unavailable);
}
/** Only the fallback retry may discard a missing-source-glyph refusal. Check
 * each code so a missing glyph never hides a later terminal source failure. */
export function type1FallbackSourceGuard(assertSource:((codes:readonly Uint8Array[])=>void)|undefined) {
  if(!assertSource)return undefined;
  return (codes:readonly Uint8Array[])=>{for(const code of codes)try{assertSource([code]);}catch(error){
    const failure=error as RunCompileError&{terminal?:boolean;diagnostic?:Type1Diagnostic};
    if(!(error instanceof RunCompileError)||failure.terminal!==false||failure.diagnostic?.code!=='glyph-unavailable')throw error;
  }};
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
