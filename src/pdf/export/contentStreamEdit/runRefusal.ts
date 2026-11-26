export type RunRefusalCode = 'unsupported-state'|'graphics-effect-unsupported'|'unsupported-matrix'|'font-unavailable'|'font-coverage'|'font-permission'|'overflow'|'stale-source'|'form-xobject';
/** Expected input refusals only. TypeError and other programming errors escape. */
export class RunCompileError extends Error {
  readonly code:RunRefusalCode;
  constructor(message:string,code:RunRefusalCode='unsupported-state'){super(message);this.code=code;}
}
export function runRefusal(reason:string,code:RunRefusalCode='unsupported-state') {return{ok:false as const,code,reason};}
