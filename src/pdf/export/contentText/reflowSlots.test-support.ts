import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';

/** Independent readback of actual string codes and paint slots, not recipe data. */
export function readSlots(bytes:Uint8Array){
 const ops=tokenizeContentStream(bytes),stack:{tag:string;mcid?:number}[]=[],fills:string[]=[];
 let fill='default';
 const shows:{op:number;mcids:number[];scope:string;fill:string;codes:number[]}[]=[];
 for(const [i,op]of ops.entries()){
  if(op.operator==='q')fills.push(fill);
  if(op.operator==='Q')fill=fills.pop()!;
  if(['g','rg','k','cs','sc','scn'].includes(op.operator))fill=op.operator+JSON.stringify(op.operands);
  if(op.operator==='BMC'||op.operator==='BDC'){
   const tag=op.operands[0],dict=op.operands[1],entry=dict?.kind==='dict'?dict.entries.find(e=>e.key==='MCID'):undefined;
   const id=entry?new TextDecoder().decode(bytes.subarray(entry.start,entry.end)).match(/^\/MCID\s+(\d+)/)?.[1]:undefined;
   stack.push({tag:tag?.kind==='name'?tag.value:'?',mcid:id===undefined?undefined:Number(id)});
  }
  if(op.operator==='EMC')stack.pop();
  if(op.operator==='Tj'||op.operator==='TJ'){
   const items=op.operator==='TJ'&&op.operands[0]?.kind==='array'?op.operands[0].items:op.operands;
   const codes=items.flatMap(t=>t.kind==='string'?[...t.bytes]:[]);
   if(codes.length)shows.push({op:i,mcids:stack.flatMap(t=>t.mcid===undefined?[]:[t.mcid]),scope:stack.map(t=>t.tag).join('>'),fill,codes});
  }
 }
 return {ops,shows};
}
export function mcidCodes(bytes:Uint8Array){
 const result:Record<number,number[]>={};
 for(const s of readSlots(bytes).shows)for(const id of s.mcids)(result[id]??=[]).push(...s.codes);
 return result;
}
