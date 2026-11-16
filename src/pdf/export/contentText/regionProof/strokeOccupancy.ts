import {PDFDict,PDFName,PDFNumber,type PDFPage} from 'pdf-lib';
import type {ContentOp} from '../../contentStreamEdit/tokenizer';
import type {UnplacedShow} from '../../contentStreamEdit/textState';
import type {streamInkResolver} from '../reflowInk';
import type {Rect,TextTrace} from './types';
import {finiteMatrix,linear} from './geometry';

/** Defaults are specified by PDF. A missing/malformed value is unknown;
 * zero-width hairlines have no resolution-independent geometric envelope. */
export function strokeEnvelopes(page:PDFPage,ops:readonly ContentOp[]):Map<number,number|undefined>{
 type State={width?:number;join?:number;cap?:number;miter?:number};
 let state:State={width:1,join:0,cap:0,miter:10};
 const stack:State[]=[],result=new Map<number,number|undefined>();
 const states=page.node.Resources()?.lookupMaybe(PDFName.of('ExtGState'),PDFDict);
 const set=(field:keyof State,value:number|undefined)=>{
  const valid=value!==undefined&&Number.isFinite(value)&&(field==='width'?value>0:field==='miter'?value>=1:Number.isInteger(value)&&value>=0&&value<=2);
  state={...state,[field]:valid?value:undefined};
 };
 for(const [i,op]of ops.entries()){
  if(op.operator==='q')stack.push({...state});
  else if(op.operator==='Q')state=stack.pop()??{};
  else if(op.operator==='gs'){
   const name=op.operands[0],dict=op.operands.length===1&&name?.kind==='name'?states?.lookupMaybe(PDFName.of(name.value),PDFDict):undefined;
   if(!dict)state={};
   else for(const [key,field]of [['LW','width'],['LJ','join'],['LC','cap'],['ML','miter']]as const){
    if(dict.has(PDFName.of(key))){const v=dict.lookup(PDFName.of(key));set(field,v instanceof PDFNumber?v.asNumber():undefined);}
   }
  }else{
   const field=({w:'width',j:'join',J:'cap',M:'miter'}as const)[op.operator as 'w'|'j'|'J'|'M'];
   if(field){const v=op.operands[0];set(field,op.operands.length===1&&v?.kind==='number'?v.value:undefined);}
  }
  const {width,join,cap,miter}=state;
  // Half width bounds round/bevel joins. Square caps need sqrt(2);
  // miter joins need the proved miter limit, including closed glyph paths.
  result.set(i,width!==undefined&&join!==undefined&&cap!==undefined&&miter!==undefined?
   width/2*Math.max(1,cap===2?Math.SQRT2:1,join===0?miter:1):undefined);
 }
 return result;
}

/** Occupancy only. Normalising Tr for ink measurement never changes the
 * source trace, the placement walk or eligibility for paragraph membership. */
export function boundStrokedShow(s:UnplacedShow,t:TextTrace,ink:ReturnType<typeof streamInkResolver>,
 declared:readonly number[]|undefined,envelope:number|undefined,media:Rect,guard:number):Rect[]|undefined{
 if(s.reason!=='graphics-effect-unsupported: stroked text (Tr 1/2)'||![1,2].includes(t.renderMode)||
  !s.origin||!Number.isFinite(s.origin.x)||!Number.isFinite(s.origin.y)||!s.fontName||
  ![t.tm,t.ctm].every(m=>finiteMatrix(m)&&Math.abs(m[1]!)<=1e-9&&Math.abs(m[2]!)<=1e-9)||
  envelope===undefined||!Number.isFinite(t.size)||t.size<=0)return;
 const radius=envelope*Math.hypot(...t.ctm.slice(0,4))+guard;
 if(!Number.isFinite(radius))return;
 const glyphs=s.glyphs?.map(g=>({g,ink:ink(g.fontName,g.code,{...t,renderMode:0,scopeSafe:true})}));
 if(glyphs&&glyphs.every(g=>g.ink&&!g.ink.conservative))return glyphs.flatMap(({g,ink})=>ink!.box.w>0&&ink!.box.h>0?
  [{x:g.coreQuad[0].x+ink!.box.x-radius,y:g.coreQuad[0].y+ink!.box.y-radius,w:ink!.box.w+2*radius,h:ink!.box.h+2*radius}]:[]);
 if(!declared)return;
 const sy=linear(t)[3]!*t.size/1000,y1=s.origin.y+declared[1]!*sy,y2=s.origin.y+declared[3]!*sy;
 if(![y1,y2].every(Number.isFinite))return;
 return [{x:media.x,y:Math.min(y1,y2)-radius,w:media.w,h:Math.abs(y2-y1)+2*radius}];
}
