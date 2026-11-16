import type {ShowTextState} from '../contentStreamEdit/textState';
import type {ContentOp} from '../contentStreamEdit/tokenizer';
import {pdfNumber} from '../contentStreamEdit/runEncoding';

type Matrices={textMatrix:readonly number[];lineMatrix:readonly number[]};
/** Visible known push ink requires horizontal text (retypesetInk). Text rise
 * supplies its page-space (0,-delta) translation without touching
 * CTM, clips, Tm or Tlm. In particular, q/cm/Q inside BT/ET loses the current
 * advance in PDFium, and an explicit Tm can materialize TJ adjustments that
 * PDFium otherwise ignores. Keep the original show and its continuation.
 * Ts is in text units, scaled by Tm and CTM, not by font size or Tz. */
export function emitRetypesetPushText(s:ShowTextState,op:ContentOp,end:Matrices,delta:number){
 const tm=s.textMatrix!,ct=s.ctm!;
 const x=tm[2]!*ct[0]!+tm[3]!*ct[2]!,y=tm[2]!*ct[1]!+tm[3]!*ct[3]!;
 // Only rise is restored. The unchanged quote operator's Tw/Tc persist.
 if(Math.abs(x)<1e-8&&y>0)return{prefix:` ${pdfNumber(s.rise!-delta/y)} Ts `,suffix:` ${pdfNumber(s.rise!)} Ts `};
 // Invisible Tr 3 text has known zero ink even with a nonhorizontal frame.
 // Preserve that existing eligibility using an explicit translated Tm, then
 // rejoin both original matrices. Never change CTM inside its text object.
 let matrix=[...tm];
 if(op.operator==="'"||op.operator==='"'){
  matrix=[...s.lineMatrix!];
  matrix[4]!+=s.leading!*matrix[2]!;matrix[5]!+=s.leading!*matrix[3]!;
 }else if(op.operator==='TJ'){
  const array=op.operands[0]!;
  if(array.kind!=='array')throw Error('missing pushed TJ array');
  // The snapshot is after any numbers preceding the first nonempty string.
  const leading=array.items.slice(0,s.arrayItemIndex).reduce((n,item)=>n+(item.kind==='number'?item.value:0),0);
  const advance=-leading*s.fontSize*s.horizontalScale!/1000;
  matrix[4]!-=advance*matrix[0]!;matrix[5]!-=advance*matrix[1]!;
 }
 const det=ct[0]!*ct[3]!-ct[1]!*ct[2]!;
 matrix[4]!+=ct[2]!*delta/det;matrix[5]!-=ct[0]!*delta/det;
 const lm=end.lineMatrix,length=lm[0]!**2+lm[1]!**2;
 const dx=end.textMatrix[4]!-lm[4]!,dy=end.textMatrix[5]!-lm[5]!;
 let suffix=` ${lm.map(pdfNumber).join(' ')} Tm `;
 if(dx!==0||dy!==0){
  const advance=(dx*lm[0]!+dy*lm[1]!)/length;
  suffix+=`[${pdfNumber(-advance*1000/(s.fontSize*s.horizontalScale!))}] TJ `;
 }
 return{prefix:` ${matrix.map(pdfNumber).join(' ')} Tm `,suffix};
}
