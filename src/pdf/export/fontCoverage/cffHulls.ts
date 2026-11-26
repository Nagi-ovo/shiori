import fontkit from '@pdf-lib/fontkit';
import type {Rect} from '../contentText/regionProof';

const defaultMatrix=[.001,0,0,.001,0,0];
type CffTopDict={FontMatrix?:number[];FDArray?:{FontMatrix?:number[]}[]};

/** CFF FontBBox declarations require CFF transforms, regardless of the PDF
 * embedding slot. Recognize the container even if program parsing fails. */
export function isCffProgram(raw:Uint8Array):boolean{
 if(raw[0]===1&&raw[2]!>=4)return true;
 if(raw.length<12)return false;
 const v=new DataView(raw.buffer,raw.byteOffset,raw.byteLength),count=v.getUint16(4);
 for(let i=0;i<count&&12+(i+1)*16<=raw.length;i++){
  if(v.getUint32(12+i*16)===0x43464620)return true; // 'CFF '
 }
 return false;
}

/** Default FD metadata is harmless (including defaults supplied by fontkit).
 * Nonstandard FD transforms remain unproved. The top matrix is applied below. */
export function cffHullMatrix(top:CffTopDict):number[]|undefined{
 if((top.FDArray??[]).some(d=>d.FontMatrix&&(d.FontMatrix.length!==6||d.FontMatrix.some((n,i)=>n!==defaultMatrix[i]))))return;
 const m=top.FontMatrix??defaultMatrix;
 return m.length===6&&m.every(Number.isFinite)?m:undefined;
}

/** Container metadata only: fontkit executes unchanged CFF bytes for the
 * Bezier control hull. Transform that hull through the supported top matrix. */
export function cffHulls(raw:Uint8Array){
 let data=raw;
 if(raw[0]===1&&raw[2]!>=4){
  const head=new Uint8Array(54);new DataView(head.buffer).setUint16(18,1000);
  const tables:[string,Uint8Array][]=[['CFF ',raw],['head',head],['maxp',Uint8Array.of(0,0,0x50,0,0xff,0xff)]];
  data=new Uint8Array(60+tables.reduce((n,[,b])=>n+Math.ceil(b.length/4)*4,0));const v=new DataView(data.buffer);
  data.set([79,84,84,79]);v.setUint16(4,3);let offset=60;
  tables.forEach(([tag,b],i)=>{const p=12+i*16;data.set(Array.from(tag,c=>c.charCodeAt(0)),p);v.setUint32(p+8,offset);v.setUint32(p+12,b.length);data.set(b,offset);offset+=Math.ceil(b.length/4)*4;});
 }
 const font=fontkit.create(data) as ReturnType<typeof fontkit.create>&{'CFF '?:{topDict:CffTopDict}};
 const top=font['CFF ']?.topDict,m=top?cffHullMatrix(top):undefined;
 if(!m)return;
 return (gid:number):Rect=>{
  const glyph=font.getGlyph(gid);if(!glyph.path.toSVG())return {x:0,y:0,w:0,h:0};const b=glyph.cbox;
  const points=[[b.minX,b.minY],[b.maxX,b.minY],[b.maxX,b.maxY],[b.minX,b.maxY]].map(([x,y])=>
   [m[0]!*x!+m[2]!*y!+m[4]!,m[1]!*x!+m[3]!*y!+m[5]!]);
  const xs=points.map(p=>p[0]!),ys=points.map(p=>p[1]!);
  return {x:Math.min(...xs),y:Math.min(...ys),w:Math.max(...xs)-Math.min(...xs),h:Math.max(...ys)-Math.min(...ys)};
 };
}
