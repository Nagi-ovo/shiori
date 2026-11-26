/** Reads only the Top DICT and FDArray FontMatrix entries of a bare CFF
 * program. A malformed or unexpected structure returns undefined. */
type Dict=Map<number,number[]>&{spans?:Map<number,[number,number]>};
function readIndex(b:Uint8Array,at:number){
 if(at+2>b.length)return;
 const count=b[at]!*256+b[at+1]!;if(!count)return{items:[] as [number,number][],end:at+2};
 const size=b[at+2]!;if(size<1||size>4)return;
 const offsets:number[]=[],base=at+3+(count+1)*size-1;
 for(let i=0;i<=count;i++){let v=0;for(let k=0;k<size;k++)v=v*256+b[at+3+i*size+k]!;offsets.push(v);}
 if(base+offsets[count]!>b.length||offsets.some((o,i)=>i&&o<offsets[i-1]!))return;
 return{items:offsets.slice(0,-1).map((o,i)=>[base+o,base+offsets[i+1]!] as [number,number]),end:base+offsets[count]!};
}
function readDict(b:Uint8Array,start:number,end:number):Dict|undefined{
 const dict:Dict=new Map(),spans=new Map<number,[number,number]>();dict.spans=spans;let operands:number[]=[],from=start;
 for(let i=start;i<end;){
  const v=b[i]!;
  if(v<=21){const op=v===12?1200+b[i+1]!:v;i+=v===12?2:1;dict.set(op,operands);spans.set(op,[from,i]);operands=[];from=i;continue;}
  if(v===28){operands.push(((b[i+1]!<<24)>>16)|b[i+2]!);i+=3;}
  else if(v===29){operands.push((b[i+1]!<<24)|(b[i+2]!<<16)|(b[i+3]!<<8)|b[i+4]!);i+=5;}
  else if(v===30){
   let s='';i++;
   for(let done=false;!done&&i<end;i++)for(const n of [b[i]!>>4,b[i]!&15]){
    if(n===15){done=true;break;}
    s+=n<10?String(n):n===10?'.':n===11?'E':n===12?'E-':n===14?'-':'';
   }
   const n=Number(s);if(!Number.isFinite(n))return;operands.push(n);
  }
  else if(v>=32&&v<=246){operands.push(v-139);i++;}
  else if(v>=247&&v<=250){operands.push((v-247)*256+b[i+1]!+108);i+=2;}
  else if(v>=251&&v<=254){operands.push(-(v-251)*256-b[i+1]!-108);i+=2;}
  else return;
 }
 return dict;
}
export function cffFontMatrices(b:Uint8Array){
 if(b.length<4||b[0]!==1)return;
 const names=readIndex(b,b[2]!),tops=names&&readIndex(b,names.end);if(!tops||tops.items.length!==1)return;
 const top=readDict(b,...tops.items[0]!);if(!top)return;
 const fds:(number[]|undefined)[]=[],fdSpans:([number,number]|undefined)[]=[];
 const fdArray=top.get(1236);
 if(fdArray){
  const index=fdArray.length===1?readIndex(b,fdArray[0]!):undefined;if(!index)return;
  for(const [s,e]of index.items){const fd=readDict(b,s,e);if(!fd)return;fds.push(fd.get(1207));fdSpans.push(fd.spans!.get(1207));}
 }
 return{top:top.get(1207),fds,fdSpans,cid:top.has(1230)};
}
const unit=[.001,0,0,.001,0,0],identity=[1,0,0,1,0,0];
const equal=(m:number[]|undefined,n:number[])=>!!m&&m.length===6&&m.every((v,i)=>Math.abs(v-n[i]!)<1e-12);
/** True when every glyph uses the default 1/1000 glyph space. A CID font
 * combines its top matrix with each FD matrix; only a unit top with identity
 * (or absent) FDs, or an identity top with unit FDs, is accepted. */
export function cffDefaultGlyphSpace(b:Uint8Array){
 const m=cffFontMatrices(b);if(!m)return false;
 const top=m.top??unit;
 if(equal(top,unit))return m.fds.every(fd=>!fd||equal(fd,identity));
 return m.cid&&equal(top,identity)&&m.fds.length>0&&m.fds.every(fd=>equal(fd,unit));
}
/** fontkit's FD dictionary schema lacks FontMatrix. When the top matrix is
 * the unit glyph space and every FD matrix is the identity (a no-op in the
 * combined transform), a private copy rewrites each such entry, byte for byte,
 * as an inert FontName so the unchanged charstrings can be outlined. */
export function withoutIdentityFdMatrices(b:Uint8Array){
 const m=cffFontMatrices(b);if(!m||!equal(m.top??unit,unit)||!m.fds.some(Boolean)||!m.fds.every(fd=>!fd||equal(fd,identity)))return;
 const copy=b.slice();
 for(const span of m.fdSpans){
  if(!span)continue;const [start,end]=span;if(end-start<3)return;
  copy.fill(139,start,end-2);copy[end-2]=12;copy[end-1]=38;
 }
 return copy;
}
