import type {ContentOp} from '../contentStreamEdit/tokenizer';
import type {PdfRect} from '../../model/types';
import {bounds} from './retypesetInk';

type Scope={ct:number[];clip:PdfRect|null|undefined;start:number;clean:boolean};
export const retypesetPaintOps=new Set(['S','s','f','F','f*','B','B*','b','b*','n']);
/** undefined = no explicit clip, null = an unproved clip shape. Only a single
 * axis-aligned rectangle proves containment; a path's bbox never does. Paths
 * themselves are not q/Q state. Captured spans exclude interleaved mutations. */
export function retypesetScopes(ops:ContentOp[],initialClip?:PdfRect|null){
 let ct=[1,0,0,1,0,0],clip:Scope['clip']=initialClip,pathStart=-1,clean=true,pathRect:PdfRect|null= null;
 let clipping=false,renderMode=0,textClip=false;
 const stack:{ct:number[];clip:Scope['clip'];renderMode:number}[]=[],contexts=new Map<number,Scope>(),pathOps=new Set(['m','l','c','v','y','h','re']);
 for(const [i,op]of ops.entries()){
  const n=op.operands.map(n=>n.kind==='number'?n.value:NaN);
  if(pathOps.has(op.operator)){
   if(pathStart<0){pathStart=i;
    pathRect=op.operator==='re'&&n.length===4&&[...n,...ct].every(Number.isFinite)&&ct[0]!==0&&ct[3]!==0&&ct[1]===0&&ct[2]===0?
     bounds([[n[0]!,n[1]!],[n[0]!+n[2]!,n[1]!+n[3]!]].map(([x,y])=>({x:ct[0]!*x!+ct[4]!,y:ct[3]!*y!+ct[5]!}))):null;
    if(pathRect&&!Object.values(pathRect).every(Number.isFinite))pathRect=null;
   }else pathRect=null;
  }else if(pathStart>=0&&!retypesetPaintOps.has(op.operator)&&!['W','W*'].includes(op.operator))clean=false;
  contexts.set(i,{ct:[...ct],clip,start:pathStart<0?i:pathStart,clean});
  if(op.operator==='q')stack.push({ct:[...ct],clip,renderMode});
  else if(op.operator==='Q'){const saved=stack.pop();if(saved){ct=saved.ct;clip=saved.clip;renderMode=saved.renderMode;}else{ct=Array(6).fill(NaN);clip=null;}}
  else if(op.operator==='cm'){
   const a=ct,m=n;
   ct=[a[0]!*m[0]!+a[2]!*m[1]!,a[1]!*m[0]!+a[3]!*m[1]!,a[0]!*m[2]!+a[2]!*m[3]!,a[1]!*m[2]!+a[3]!*m[3]!,a[0]!*m[4]!+a[2]!*m[5]!+a[4]!,a[1]!*m[4]!+a[3]!*m[5]!+a[5]!];
  }else if(op.operator==='W'||op.operator==='W*'){clipping=true;clean=false;}
  else if(op.operator==='Tr')renderMode=n.length===1&&Number.isInteger(n[0])?n[0]!:NaN;
  else if(['Tj','TJ',"'",'"'].includes(op.operator)&&(renderMode>=4||!Number.isFinite(renderMode)))textClip=true;
  else if(op.operator==='ET'&&textClip){clip=null;textClip=false;}
  if(retypesetPaintOps.has(op.operator)){
   if(clipping){
    // W applies the complete path at its terminating paint/n operator.
    // Later subpaths must never inherit an earlier rectangle's proof.
    if(clip===null||!pathRect)clip=null;
    else if(clip===undefined)clip=pathRect;
    else{const x=Math.max(clip.x,pathRect.x),y=Math.max(clip.y,pathRect.y);clip={x,y,w:Math.max(0,Math.min(clip.x+clip.w,pathRect.x+pathRect.w)-x),h:Math.max(0,Math.min(clip.y+clip.h,pathRect.y+pathRect.h)-y)};}
   }
   pathStart=-1;clean=true;pathRect=null;clipping=false;
  }
 }
 return contexts;
}
