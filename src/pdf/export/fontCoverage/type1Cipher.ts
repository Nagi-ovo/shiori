import {rejectType1,type1Budget,type1Limits} from './type1Support';
/** Adobe Type 1 byte cipher, original implementation from the format algorithm. */
export function decryptType1(bytes:Uint8Array,seed:55665|4330,discard:number):Uint8Array {
  const code=seed===55665?'type1-eexec-invalid':'type1-charstring-invalid';
  if(!Number.isInteger(discard)||discard< -1||discard>32||bytes.length<Math.max(0,discard))rejectType1(code,'invalid cipher prefix / lenIV');
  if(bytes.length>type1Limits.bytes)type1Budget('type1-cipher','decoded-bytes');
  if(discard===-1)return bytes.slice();
  const out=new Uint8Array(bytes.length-discard);let state:number=seed;
  for(let i=0;i<bytes.length;i++){const c=bytes[i]!,b=c^(state>>>8);state=((c+state)*52845+22719)&65535;if(i>=discard)out[i-discard]=b;}
  return out;
}
