import type {ContentOp,ContentOperand} from '../contentStreamEdit/tokenizer';
import type {ResolvedRunFont} from '../contentStreamEdit/replaceRun';
import {codes} from '../contentStreamEdit/runEncoding';
import type {TextTrace} from './regionProof';
import type {RunEnvironment} from '../contentStreamEdit/textSafety';
export class ReflowTraceError extends Error {}

const identity=()=>[1,0,0,1,0,0];
const multiply=(a:number[],b:number[])=>[a[0]!*b[0]!+a[2]!*b[1]!,a[1]!*b[0]!+a[3]!*b[1]!,
 a[0]!*b[2]!+a[2]!*b[3]!,a[1]!*b[2]!+a[3]!*b[3]!,a[0]!*b[4]!+a[2]!*b[5]!+a[4]!,a[1]!*b[4]!+a[3]!*b[5]!+a[5]!];
const nums=(values:readonly ContentOperand[],count:number)=>{
 if(values.length!==count||values.some(n=>n.kind!=='number'||!Number.isFinite(n.value)))throw new ReflowTraceError('malformed numeric text state');
 return values.map(n=>(n as {value:number}).value);
};
const inert=new Set(['rg','RG','k','K','g','G','cs','CS','sc','SC','scn','SCN','w','J','j','M','d','ri','i','m','l','c','v','y','h','re',
 'S','s','f','F','f*','B','B*','b','b*','n','Do','BMC','BDC','EMC','MP','DP','sh','W','W*']);
/** Full read-only matrix/parameter trace for the bounded subset. q/Q saves
 * graphics/text parameters, never Tm/Tlm. Unknown state refuses this request.
 * This validates supplied R1 snapshots; it supplies no scene or ink proof.
 */
export function traceReflowSource(ops:readonly ContentOp[],fonts:readonly ResolvedRunFont[],safetyHash:string,environment:RunEnvironment={}){
 let state={ctm:identity(),fontObject:'',fontName:'',size:0,tc:0,tw:0,tz:100,leading:0,rise:0,renderMode:0};
 const stack:typeof state[]=[],anchors=new Map<number,TextTrace>(),ends=new Map<number,TextTrace>();
 const shows=new Map<string,{before:TextTrace;after:TextTrace}>();
 const marked:{operator:'BMC'|'BDC';tag:string;mcid?:number;safe:boolean}[]=[];
 let bt=-1,tm=identity(),tlm=identity();
 const snapshot=(opIndex:number):TextTrace=>({...state,bt,opIndex,ctm:[...state.ctm],tm:[...tm],tlm:[...tlm],safetyHash,
  scopeKey:JSON.stringify(marked.map(s=>[s.operator,s.tag])),mcids:marked.flatMap(s=>s.mcid===undefined?[]:[s.mcid]),scopeSafe:marked.every(s=>s.safe)});
 const translate=(matrix:number[],dx:number,dy:number)=>multiply(matrix,[1,0,0,1,dx,dy]);
 for(const [i,op]of ops.entries()){
  const n=op.operands;
  switch(op.operator){
   case 'BMC':case 'BDC':{
    const tag=n[0],properties=n[1];
    let safe=tag?.kind==='name'&&tag.value!=='OC'&&n.length===(op.operator==='BDC'?2:1),mcid:number|undefined;
    if(op.operator==='BDC'){
     const keys=properties?.kind==='dict'?properties.entries.map(e=>e.key):properties?.kind==='name'?environment.markedContentProperties?.get(properties.value):null;
     safe=!!safe&&!!keys&&keys.every(k=>k==='MCID');
     if(keys?.includes('MCID')){
      mcid=properties?.kind==='dict'?properties.entries.find(e=>e.key==='MCID')?.numberValue:properties?.kind==='name'?environment.markedContentMcids?.get(properties.value):undefined;
      safe=safe&&mcid!==undefined&&Number.isSafeInteger(mcid)&&mcid>=0&&keys.length===1;
     }
    }
    marked.push({operator:op.operator,tag:tag?.kind==='name'?tag.value:'',mcid,safe});break;
   }
   case 'EMC':if(n.length||!marked.pop())throw new ReflowTraceError('unbalanced marked content');break;
   case 'q':stack.push({...state,ctm:[...state.ctm]});break;
   case 'Q':{const saved=stack.pop();if(!saved)throw new ReflowTraceError('unbalanced graphics state');state=saved;break;}
   case 'cm':state.ctm=multiply(state.ctm,nums(n,6));break;
   case 'BT':bt=i;tm=identity();tlm=identity();break;
   case 'ET':bt=-1;break;
   case 'Tf':{
    if(n.length!==2||n[0]?.kind!=='name'||n[1]?.kind!=='number')throw new ReflowTraceError('malformed Tf');
    const name=(n[0] as {value:string}).value,font=fonts.find(f=>f.resourceName===name);
    state.fontName=name;state.fontObject=font?.objectId??'';state.size=n[1].value;break;
   }
   case 'gs':{
    const name=n[0];if(name?.kind!=='name')throw new ReflowTraceError('malformed gs');
    if(environment.extGStates?.get(name.value)?.setsFont!==false){state.fontName='';state.fontObject='';}break;
   }
   case 'Tc':state.tc=nums(n,1)[0]!;break;
   case 'Tw':state.tw=nums(n,1)[0]!;break;
   case 'Tz':state.tz=nums(n,1)[0]!;break;
   case 'TL':state.leading=nums(n,1)[0]!;break;
   case 'Ts':state.rise=nums(n,1)[0]!;break;
   case 'Tr':state.renderMode=nums(n,1)[0]!;break;
   case 'Tm':tm=nums(n,6);tlm=[...tm];anchors.set(i,snapshot(i));break;
   case 'Td':case 'TD':case 'T*':{
    const [dx,dy]=op.operator==='T*'?[0,-state.leading]:nums(n,2);
    if(op.operator==='TD')state.leading=-dy!;
    tm=translate(tlm,dx!,dy!);tlm=[...tm];anchors.set(i,snapshot(i));break;
   }
   case 'Tj':case 'TJ':{
    const items=op.operator==='TJ'&&n[0]?.kind==='array'?n[0].items:n;
    const font=fonts.find(f=>f.resourceName===state.fontName);if(bt<0)throw new ReflowTraceError('unplaced trace show');
    for(const [j,item]of items.entries()){
     if(item.kind==='number'&&op.operator==='TJ')tm=translate(tm,-item.value/1000*state.size*state.tz/100,0);
     else if(item.kind==='string'){
      const before=snapshot(i);
      const advance=font?codes(item.bytes,font.bytesPerCode).reduce((sum,code)=>sum+
       (font.widthOf(code)*state.size/1000+state.tc+(font.bytesPerCode===1&&code===32?state.tw:0))*state.tz/100,0)
       :NaN;
      tm=translate(tm,advance,0);shows.set(`${i}:${op.operator==='TJ'?j:-1}`,{before,after:snapshot(i)});
     }else throw new ReflowTraceError('malformed trace show');
    }
    break;
   }
   default:if(!inert.has(op.operator))throw new ReflowTraceError(`unsupported trace operator ${op.operator}`);
  }
  ends.set(i,snapshot(i));
 }
 return {anchors,shows,ends};
}
