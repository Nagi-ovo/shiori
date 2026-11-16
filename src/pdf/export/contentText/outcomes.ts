import type {Refusal} from '../contentStreamEdit/replaceRun';
/** Stable public codes shared by export, preview, translations and corpus reports. */
export const contentTextReasons = [
 'source-mismatch','ambiguous-match','glyph-boundary','cross-item','reflow-required',
 'form-xobject','unsupported-matrix','unsupported-state','graphics-effect-unsupported','font-unavailable',
 'font-coverage','font-permission','overflow','style-change','stale-source',
 'preview-unavailable','missing-source-style','shared-text-object',
 'unsupported-no-text-layer','unsupported-image-text','unsupported-form-xobject','unsupported-unwritable','unsupported-vertical-writing',
] as const;
export type ContentTextReason=typeof contentTextReasons[number];
export type ContentTextOutcome={overlayId:string;mode:'in-place'|'fallback-font'|'substituted'|'reflowed'|'retypeset'|'unsupported';fidelity?:'exact'|'approximate';retypeset?:import('./retypesetTypes').RetypesetManifest;reason?:ContentTextReason;detail?:string;reflow?:import('./reflowManifest').AppliedReflowManifest};
/** Compiler codes carry classification; text is diagnostic evidence only. */
export function compilerReason(failure:Refusal|string):ContentTextReason {
 if(typeof failure!=='string' && failure.code)return failure.code;
 const message=typeof failure==='string'?failure:failure.reason;
 const legacy:Record<string,ContentTextReason>={
  'replacement overflows available space':'overflow','form invocation edits are unsupported':'form-xobject',
  'stale source fingerprint':'stale-source','page changed during fallback preparation':'stale-source',
  'source font coverage unavailable':'font-coverage','source font coverage unverified':'font-coverage',
  'clip/graphics/semantic dependent target':'unsupported-state','malformed marked content':'unsupported-state',
  'graphics-effect-unsupported: stroked text (Tr 1/2)':'graphics-effect-unsupported',
 };
 for(const op of ['Tj','TJ','Tf','cm','Tm','gs',"'",'"'])legacy[`malformed ${op} operands`]='unsupported-state';
 if(legacy[message])return legacy[message];
 throw Error(`Compiler refusal is missing a stable code: ${message}`);
}
