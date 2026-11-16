import type {ContentOp} from '../../contentStreamEdit/tokenizer';
import {coefficientEqual} from './geometry';

const identity=()=>[1,0,0,1,0,0];
/** Track wrappers across the entire source, including q before the window.
 * A cm must be outside BT and inside a q/Q whose endpoints are both outside
 * BT and which encloses at least one complete text object. */
export function operatorScopes(ops:readonly ContentOp[]){
 const fail=(detail:string)=>({ok:false as const,detail});
 let bt=-1,marked=0,ctm=identity(),applied:number[]=[];
 type Frame={bt:number;ctm:number[];cms:number[];wholeBts:number;applied:number[]};
 const stack:Frame[]=[],owners=new Map<number,number>(),ctms=new Map<number,readonly number[]>(),safeCms=new Set<number>();
 const appliedCms=new Map<number,readonly number[]>();
 for(let i=0;i<ops.length;i++){
  const op=ops[i]!,n=op.operands;
  switch(op.operator){
   case 'BT':
    if(bt!==-1||n.length)return fail('Nested or malformed BT');
    bt=i;break;
   case 'ET':
    if(bt===-1||n.length)return fail('Unbalanced ET');
    for(const frame of stack)if(frame.bt===-1)frame.wholeBts++;
    bt=-1;break;
   case 'q':
    if(n.length)return fail('Malformed q');
    stack.push({bt,ctm:[...ctm],cms:[],wholeBts:0,applied});break;
   case 'Q':{
    const frame=stack.pop();if(n.length||!frame)return fail('Unbalanced graphics state');
    if(frame.bt===-1&&bt===-1&&frame.wholeBts>0)for(const cm of frame.cms)safeCms.add(cm);
    ctm=frame.ctm;applied=frame.applied;ctms.set(i,ctm);break;
   }
   case 'cm':{
    if(n.length!==6||n.some(v=>v.kind!=='number'||!Number.isFinite(v.value)))return fail('Malformed cm');
    const m=n.map(v=>(v as {value:number}).value),[a,b,c,d,e,f]=ctm;
    ctm=[a!*m[0]!+c!*m[1]!,b!*m[0]!+d!*m[1]!,a!*m[2]!+c!*m[3]!,b!*m[2]!+d!*m[3]!,a!*m[4]!+c!*m[5]!+e!,b!*m[4]!+d!*m[5]!+f!];
    const frame=stack.at(-1);
    if(bt===-1&&frame&&m.slice(0,4).every((v,j)=>coefficientEqual(v,[1,0,0,1][j]!)))frame.cms.push(i);
    applied=[...applied,i];ctms.set(i,ctm);break;
   }
   case 'BMC':case 'BDC':marked++;break;
   case 'EMC':if(--marked<0)return fail('Unbalanced marked content');break;
  }
  owners.set(i,bt);
  if(['Tm','Td','TD','T*','Tj','TJ'].includes(op.operator))appliedCms.set(i,applied);
 }
 if(bt!==-1||stack.length||marked)return fail('Unterminated source scope');
 return {ok:true as const,owners,ctms,safeCms,appliedCms};
}
