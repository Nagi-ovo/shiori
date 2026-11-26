import type {AnchoredAnnotation} from '../sourceAnnotationAnchors';
import type {Refusal} from '../contentStreamEdit/replaceRun';
/** Stable public codes shared by export, preview, translations and corpus reports. */
export const contentTextReasons = [
 'source-mismatch','ambiguous-match','glyph-boundary','cross-item','reflow-required',
 'form-xobject','unsupported-matrix','unsupported-state','graphics-effect-unsupported','font-unavailable',
 'font-coverage','font-permission','overflow','style-change','stale-source',
 'annotation-anchor','preview-unavailable','missing-source-style','shared-text-object','acceptance-strict','semantic-dependency',
 'unsupported-no-text-layer','unsupported-unverified-text','unsupported-image-text','unsupported-form-xobject','unsupported-unwritable','unsupported-vertical-writing','unsupported-artwork-contact',
 'flow-ambiguous-frame','flow-cross-page-unsupported','flow-unsupported-text','flow-destination-obstacle','flow-chain-exhausted',
] as const;
export type ContentTextReason=typeof contentTextReasons[number];
export type ContentTextOutcome={overlayId:string;mode:'in-place'|'fallback-font'|'substituted'|'reflowed'|'retypeset'|'unsupported';fidelity?:'exact'|'approximate';retypeset?:import('./retypesetTypes').RetypesetManifest;reason?:ContentTextReason;detail?:string;anchoredAnnotations?:AnchoredAnnotation[];
 /** Zero-based index in the output page order. */
 pageIndex?:number;
 contact?:import('./contact').ContentTextContact;
 /** The installed edit removed or invalidated a text equivalent it covered. */
 strippedEquivalent?:boolean;
 /** The native source face and fit frame were preserved by reducing letter spacing. */
 sourceSpacingAdjusted?:boolean;
 /** Unembedded original face with independently checked standard advances. */
 standardFontMetrics?:boolean;
 /** Bundled faces this accepted edit wrote, recorded where the writer chose
  * them; absent when the source font was kept or the name was not recorded. */
 faces?:readonly string[];
 /** Diagnostic only: first exact-tier reflow gate that refused (never a policy input). */
 exactGate?:string;exactGateDetail?:string;
 /** Diagnostic only: the operator class that made an `unsupported-state` target unsafe. */
 unsafeOperator?:import('../contentStreamEdit/replaceRun').RunUnsafeOperator;
 /** Diagnostic only: the reflow gate of a failed substitute-font retry. */
 substituteGate?:string;reflow?:import('./reflowManifest').AppliedReflowManifest;
 /** Change window of an accepted linked-frame flow edit. */
 flow?:import('./flow/flowTypes').FlowManifest};
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
