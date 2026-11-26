import type {PdfRect} from '../../model/types';

type Row={y:number;boxes:readonly PdfRect[]};
/** Preserve size first, then reduce uniformly by at most 15%, the same
 * bounded size floor used by paragraph fitting. These are proposals only. */
export function* verticalFitScales(){for(let n=100;n>=85;n--)yield n/100;}
/** Candidate upward translations of whole rows in one column. Keep the
 * first row fixed and at least 0.8 em between row origins. Ink that shares
 * an x interval stays separated by 0.02 pt, including non-adjacent rows.
 * These are proposals only: callers must prove page, clip, mask, stationary
 * ink and paint for the complete destination before installing anything. */
export function* tightenedColumnOffsets(rows:readonly Row[],em:number,step:number):Generator<number[]>{
 if(rows.length<2||!(em>0&&step>=em*.8)||!Number.isFinite(step)||rows.some(r=>!Number.isFinite(r.y)||!r.boxes.length||r.boxes.some(b=>![b.x,b.y,b.w,b.h].every(Number.isFinite)||b.w<0||b.h<0)))return;
 const packed=[rows[0]!.y];
 for(let i=1;i<rows.length;i++){
  const row=rows[i]!;let y=packed[i-1]!-em*.8;
  for(let j=0;j<i;j++)for(const a of rows[j]!.boxes)for(const b of row.boxes){
   if(a.w>0&&a.h>0&&b.w>0&&b.h>0&&a.x<b.x+b.w&&b.x<a.x+a.w)y=Math.min(y,a.y+packed[j]!-rows[j]!.y-.02-(b.y+b.h-row.y));
  }
  // Tightening must never extend the original row or reverse its order.
  if(y<row.y-1e-7||rows[i-1]!.y-row.y<em*.8-1e-7)return;
  packed.push(y);
 }
 if(packed.at(-1)!-rows.at(-1)!.y<1e-7)return;
 // Approach the fully packed candidate gradually, preserving as much of
 // the observed spacing as possible. Every candidate gets the same proof.
 for(let n=1;n<=32;n++)yield rows.map((r,i)=>(packed[i]!-r.y)*n/32);
}
