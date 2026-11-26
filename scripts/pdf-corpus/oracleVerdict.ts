import assert from 'node:assert/strict';
import {assertRetypesetPopplerText} from './retypesetPoppler';

const compact=(s:string)=>s.replace(/\s/gu,'');
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
/** Thrown when the legacy comparator fails: the hard gate still follows it,
 * but the corrected verdict travels with the failure. */
export class OracleVerdictError extends Error{
 constructor(message:string,readonly legacyPassed:boolean,readonly correctedPassed:boolean){super(message);this.name='OracleVerdictError';}
}
/** Verdicts for a failed audit; an error thrown before the dual-verdict check
 * failed a check both verdicts share. */
export function oracleVerdicts(error:unknown){
 return error instanceof OracleVerdictError?{legacyPassed:error.legacyPassed,correctedPassed:error.correctedPassed}:{legacyPassed:false,correctedPassed:false};
}
/** Reflow-manifest samples, Poppler side. Legacy: Poppler's after text must
 * equal PDFium's after text, which fails on reading order alone (two-column
 * interleave, a moved folio) and on PDFium U+0002 vs Poppler '-'. Corrected:
 * the signed scalar delta the retypeset path already trusts, Poppler before
 * -> after against PDFium before -> after. Inputs are raw extractions. */
export function manifestPopplerVerdict(popplerBefore:string,popplerAfter:string,nativeBefore:string,nativeAfter:string){
 let legacyError:string|undefined,correctedError:string|undefined,evidence:ReturnType<typeof assertRetypesetPopplerText>|undefined;
 try{assert.equal(compact(popplerAfter),compact(nativeAfter),'Poppler extracted text mismatch');}catch(error){legacyError=message(error);}
 try{evidence=assertRetypesetPopplerText(popplerBefore,popplerAfter,nativeBefore,nativeAfter);}catch(error){correctedError=message(error);}
 const legacyPassed=legacyError===undefined,correctedPassed=correctedError===undefined;
 return {legacyPassed,correctedPassed,legacyError,correctedError,popplerComparison:'before-after-scalar-delta' as const,
  popplerLegacyComparison:'after-string-equality' as const,...(evidence?{popplerSourceDifferences:evidence.popplerSourceDifferences}:{})};
}

type Space={text:string;origin:readonly number[];fontHash?:string};
type Rect={x:number;y:number;w:number;h:number};
const inside=(g:Space,rects:readonly Rect[])=>rects.some(r=>g.origin[0]!>=r.x-.01&&g.origin[0]!<=r.x+r.w+.01&&g.origin[1]!>=r.y-.01&&g.origin[1]!<=r.y+r.h+.01);
/** Corrected verdict only. A whitespace gap whose one native neighbour was
 * replaced belongs to the edited span iff originalText and the replacement
 * both carry whitespace at that boundary, every source space was selected,
 * and the substitution re-emitted the same spaces in the adjacent
 * replacement glyph's font program inside the edit boxes. */
export function editedBoundarySpaces(spaces:readonly Space[],observed:readonly Space[],edit:{originalText:string;text:string;coverRects:readonly Rect[]},replacement:Space|undefined,trailing:boolean){
 const boundary=trailing?/\s$/u:/^\s/u;
 return Boolean(replacement?.fontHash)&&boundary.test(edit.originalText)&&boundary.test(edit.text)&&observed.length===spaces.length&&
  spaces.every((space,i)=>inside(space,edit.coverRects)&&observed[i]!.text===space.text&&observed[i]!.fontHash===replacement!.fontHash&&inside(observed[i]!,edit.coverRects));
}
