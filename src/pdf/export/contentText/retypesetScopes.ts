import type {ContentOp} from '../contentStreamEdit/tokenizer';
import type {PdfRect} from '../../model/types';
import {bounds} from './retypesetInk';

type Scope={ct:number[];clip:PdfRect|null|undefined;start:number;clean:boolean};
export const retypesetPaintOps=new Set(['S','s','f','F','f*','B','B*','b','b*','n']);
/** undefined = no explicit clip, null = an unproved clip shape. Only a single
 * axis-aligned rectangle proves containment; a path's bbox never does. Paths
 * themselves are not q/Q state. Captured spans exclude interleaved mutations. */
export function retypesetScopes(ops:ContentOp[],initialClip?:PdfRect){
 let ct=[1,0,0,1,0,0],clip:Scope['clip']=initialClip,pathStart=-1,clean=true,pathRect:PdfRect|null= null,pending:Scope['clip'];
 let clipping=false;
 const stack:{ct:number[];clip:Scope['clip']}[]=[],contexts=new Map<number,Scope>(),pathOps=new Set(['m','l','c','v','y','h','re']);
 for(const [i,op]of ops.entries()){
  const n=op.operands.map(n=>n.kind==='number'?n.value:NaN);
  if(pathOps.has(op.operator)){
   if(pathStart<0){pathStart=i;
    pathRect=op.operator==='re'&&n.length===4&&n.every(Number.isFinite)&&Math.abs(ct[1]!)<1e-10&&Math.abs(ct[2]!)<1e-10?
     bounds([[n[0]!,n[1]!],[n[0]!+n[2]!,n[1]!+n[3]!]].map(([x,y])=>({x:ct[0]!*x!+ct[4]!,y:ct[3]!*y!+ct[5]!}))):null;
   }else pathRect=null;
  }else if(pathStart>=0&&!retypesetPaintOps.has(op.operator)&&!['W','W*'].includes(op.operator))clean=false;
  contexts.set(i,{ct:[...ct],clip,start:pathStart<0?i:pathStart,clean});
  if(op.operator==='q')stack.push({ct:[...ct],clip});
  else if(op.operator==='Q'){const saved=stack.pop();if(saved){ct=saved.ct;clip=saved.clip;}}
  else if(op.operator==='cm'){
   const a=ct,m=n;
   ct=[a[0]!*m[0]!+a[2]!*m[1]!,a[1]!*m[0]!+a[3]!*m[1]!,a[0]!*m[2]!+a[2]!*m[3]!,a[1]!*m[2]!+a[3]!*m[3]!,a[0]!*m[4]!+a[2]!*m[5]!+a[4]!,a[1]!*m[4]!+a[3]!*m[5]!+a[5]!];
  }else if(op.operator==='W'||op.operator==='W*'){pending=pathRect;clipping=true;clean=false;}
  if(retypesetPaintOps.has(op.operator)){
   if(clipping){
    if(clip===null||!pending)clip=null;
    else if(clip===undefined)clip=pending;
    else{const x=Math.max(clip.x,pending.x),y=Math.max(clip.y,pending.y);clip={x,y,w:Math.max(0,Math.min(clip.x+clip.w,pending.x+pending.w)-x),h:Math.max(0,Math.min(clip.y+clip.h,pending.y+pending.h)-y)};}
   }
   pathStart=-1;clean=true;pathRect=null;pending=undefined;clipping=false;
  }
 }
 return contexts;
}
