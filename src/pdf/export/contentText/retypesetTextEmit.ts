import type {ShowTextState} from '../contentStreamEdit/textState';
import type {ContentOp} from '../contentStreamEdit/tokenizer';
import type {ResolvedRunFont} from '../contentStreamEdit/replaceRun';
import {hex,pdfName,pdfNumber,codes} from '../contentStreamEdit/runEncoding';
import type {readRetypesetSource} from './retypesetSource';
import type {planRetypeset} from './retypesetPlan';
import type {RetypesetCluster} from './retypesetTypes';
import {restoreReflowSlot} from './reflowEmit';
import {retypesetClusterState} from './retypesetLayout';

function restore(s:ShowTextState,fonts:ResolvedRunFont[]){
 return restoreReflowSlot({bt:0,opIndex:s.opIndex,ctm:s.ctm!,tm:s.textMatrix!,tlm:s.lineMatrix!,fontObject:fonts.find(f=>f.resourceName===s.fontName)!.objectId,size:s.fontSize,tc:s.charSpacing,tw:s.wordSpacing,tz:s.horizontalScale!*100,leading:s.leading!,rise:s.rise!,renderMode:s.renderMode!,safetyHash:'approximate'},fonts);
}
/** Text emission for every home show, from the clusters' current planned
 * positions. Called at compile time, so a fit rolled back before a retry
 * compiles from its restored positions. */
export function emitRetypesetText(plans:ReturnType<typeof planRetypeset>[],source:ReturnType<typeof readRetypesetSource>,fonts:ResolvedRunFont[],removedOps:ContentOp[],oldShows:number[],newShows:number[],skip:(a:RetypesetCluster)=>boolean,pinned:RetypesetCluster[]){
 type Plan=ReturnType<typeof planRetypeset>;
 const byOp=new Map<number,{a:RetypesetCluster;p:Plan}[]>();
 const append=(id:number,a:RetypesetCluster,p:Plan)=>{
  const list=byOp.get(id)??[];list.push({a,p});byOp.set(id,list);
 };
 for(const plan of plans)for(const a of plan.output)if(!a.hard&&!skip(a))append(a.home.glyph.opIndex,a,plan);
 for(const fixed of pinned){
  const g=fixed.home.glyph,id=g.opIndex,list=byOp.get(id);
  // Pure deletion has no planned atom at this show. Its plan still owns the
  // removed bytes and supplies the transform for pinned neighbours.
  const p=list?.[0]?.p??plans.find(plan=>plan.tail.some(t=>t.glyph.opIndex===id))!;
  const at=p.frame.local(fixed.home.x,fixed.home.y);
  const a={...fixed,...at,advance:NaN};
  if(!list){append(id,a,p);continue;}
  const index=list.findIndex(({a})=>a.home.glyph.arrayItemIndex>g.arrayItemIndex||
    a.home.glyph.arrayItemIndex===g.arrayItemIndex&&a.home.glyph.byteOffset>g.byteOffset);
  list.splice(index<0?list.length:index,0,{a,p});
 }
 const textPatches:{start:number;body:string}[]=[];
 for(const [opIndex,entries]of byOp){
  const atoms=entries.map(({a})=>a);
  const before={...source.glyphs.find(g=>g.glyph.opIndex===opIndex)!.state,...source.ends.get(opIndex)!},body:string[]=[' q'];
  for(let cursor=0;cursor<atoms.length;){
   const a=atoms[cursor]!;
   const p=entries[cursor]!.p,global=p.frame.global(a.x!,a.y!),s=retypesetClusterState(a),ct=s.ctm!,tm=s.textMatrix!,det=ct[0]!*ct[3]!-ct[1]!*ct[2]!;
   const x=(ct[3]!*(global.x-ct[4]!)-ct[2]!*(global.y-ct[5]!))/det-s.rise!*tm[2]!;
   const y=(-ct[1]!*(global.x-ct[4]!)+ct[0]!*(global.y-ct[5]!))/det-s.rise!*tm[3]!;
   const along=(dx:number)=>{
    const q=p.frame.global(dx,0),tx=(ct[3]!*q.x-ct[2]!*q.y)/det,ty=(-ct[1]!*q.x+ct[0]!*q.y)/det;
    const length=tm[0]!**2+tm[1]!**2,advance=(tx*tm[0]!+ty*tm[1]!)/length;
    return{advance,across:Math.hypot(tx-advance*tm[0]!,ty-advance*tm[1]!)};
   };
   // Keep adjacent characters in one real show string. Per-character Tm/Tj
   // fragments can make PDFium extract a newline after every character.
   let end=cursor+1;
   for(;end<atoms.length;end++){
    const next=atoms[end]!,previous=atoms[end-1]!,ns=retypesetClusterState(next);
    if(!Number.isFinite(previous.advance)||entries[end]!.p!==p||next.font!==a.font||Math.abs(next.y!-a.y!)>1e-8||Math.abs(next.x!-previous.x!-previous.advance!)>1e-7||along(next.x!-previous.x!).across>1e-8||
     (['fontSize','charSpacing','wordSpacing','horizontalScale','rise','renderMode']as const).some(k=>ns[k]!==s[k])||
     ns.textMatrix!.slice(0,4).some((v,i)=>v!==tm[i])||ns.ctm!.some((v,i)=>v!==ct[i]))break;
   }
   const items:string[]=[];let adjusted=false;
   for(let i=cursor;i<end;i++){
    const current=atoms[i]!;items.push(hex(current.bytes!));
    if(i+1===end)continue;
    const code=codes(current.bytes!,current.font!.bytesPerCode)[0]!;
    const natural=current.font!.widthOf(code)*s.fontSize/1000+s.charSpacing+(current.font!.bytesPerCode===1&&code===32?s.wordSpacing:0);
    // Different source lines can have different text-matrix scales. TJ
    // reaches the planned destination in this home slot's own text space.
    const adjustment=(natural-along(atoms[i+1]!.x!-current.x!).advance/s.horizontalScale!)*1000/s.fontSize;
    if(Math.abs(adjustment)>1e-10){items.push(pdfNumber(adjustment));adjusted=true;}
   }
   const show=adjusted?`[${items.join(' ')}] TJ`:`${hex(Uint8Array.from(atoms.slice(cursor,end).flatMap(t=>[...t.bytes!])))} Tj`;
   body.push(`${[...tm.slice(0,4),x,y].map(pdfNumber).join(' ')} Tm ${pdfName(a.font!.resourceName)} ${pdfNumber(s.fontSize)} Tf ${pdfNumber(s.charSpacing)} Tc ${pdfNumber(s.wordSpacing)} Tw ${pdfNumber(s.horizontalScale!*100)} Tz ${pdfNumber(s.rise!)} Ts ${s.renderMode} Tr ${show}`);
   cursor=end;
  }
  body.push('Q',restore(before,fonts));
  // Quote operators move the line before showing. Insert after an explicit
  // equivalent prefix; source snapshots are already after that line move.
  const rewritten=removedOps[newShows[oldShows.indexOf(opIndex)]!]!;
  textPatches.push({start:rewritten.end,body:body.join(' ')+' '});
 }
 return textPatches;
}
