import type {ColumnAtom} from './uprightColumnEmit';
import type {ColumnSlot} from './uprightColumnPlan';
import type {columnInk} from './uprightColumnInk';
import {tightenedColumnOffsets,verticalFitScales} from './verticalSpacing';

/** Remeasure every cell at the emitted size, including whole TCY cells.
 * Its column centre and first row stay fixed. Each proposal still requires
 * the caller's complete clip, page, stationary ink and paint proof. */
export function* fittedUprightColumns(rows:readonly ColumnAtom[][],slots:readonly ColumnSlot[],em:number,step:number,ink:ReturnType<typeof columnInk>){
 for(const scale of verticalFitScales()){
  const resized=rows.map((r,i)=>r.map(a=>{
   if(scale===1)return a;
   const slot=slots[i]!,home={...a.home,state:{...a.home.state,fontSize:a.home.state.fontSize*scale}};
   const origin={x:slot.cx+(a.origin.x-slot.cx)*scale,y:slot.y+(a.origin.y-slot.y)*scale};
   const measured=ink(a.font,a.code,home.state,origin.x,origin.y);
   if(!measured.known)throw Error('vertical-glyph: fitted ink is unproved');
   return{...a,home,origin,box:measured.box};
  }));
  if(scale<1)yield resized.flat();
  for(const offsets of tightenedColumnOffsets(resized.map((r,i)=>({y:slots[i]!.y,boxes:r.map(a=>a.box)})),em*scale,step)){
   yield resized.flatMap((r,i)=>r.map(a=>({...a,origin:{...a.origin,y:a.origin.y+offsets[i]!},box:{...a.box,y:a.box.y+offsets[i]!}})));
  }
 }
}
