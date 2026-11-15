import {RunCompileError} from './runRefusal';
/** Fontkit's short-loca subset writer truncates odd glyph offsets. Carlito
 * uses long loca and unpadded glyphs. Pad the input glyph records, retaining
 * their bytes, metrics and GIDs; the existing embedder still makes the subset.
 * Rebuild table offsets/checksums without modifying the bundled source bytes. */
export function padFallbackTrueTypeGlyphs(data:Uint8Array):Uint8Array {
 const view=new DataView(data.buffer,data.byteOffset,data.byteLength);
 if(data.length<12||![0x00010000,0x74727565].includes(view.getUint32(0)))return data;
 const count=view.getUint16(4),records:{name:string;data:Uint8Array}[]=[];
 function invalid():never{throw new RunCompileError('invalid bundled TrueType table bounds','font-coverage');}
 if(count>256||12+count*16>data.length)invalid();
 for(let i=0;i<count;i++){
  const p=12+i*16,offset=view.getUint32(p+8),length=view.getUint32(p+12);
  if(offset+length>data.length)invalid();
  records.push({name:String.fromCharCode(...data.subarray(p,p+4)),data:new Uint8Array(data.subarray(offset,offset+length))});
 }
 const table=(name:string)=>records.find(t=>t.name===name)?.data;
 const head=table('head'),maxp=table('maxp'),loca=table('loca'),glyf=table('glyf');
 if(!head||head.length<54||!maxp||maxp.length<6||!loca||!glyf)invalid();
 const hv=new DataView(head.buffer),format=hv.getInt16(50),glyphs=new DataView(maxp.buffer).getUint16(4),lv=new DataView(loca.buffer);
 if(format===0)return data;
 if(format!==1||loca.length<(glyphs+1)*4)invalid();
 const offsets=Array.from({length:glyphs+1},(_,i)=>lv.getUint32(i*4));
 if(offsets.some((v,i)=>v>glyf.length||(i>0&&v<offsets[i-1]!)))invalid();
 if(offsets.every(n=>n%2===0))return data;
 const chunks:Uint8Array[]=[],paddedOffsets=[0];let size=0;
 for(let i=0;i<glyphs;i++){
  const chunk=glyf.slice(offsets[i],offsets[i+1]);chunks.push(chunk);size+=chunk.length;
  if(size%2){chunks.push(Uint8Array.of(0));size++;}paddedOffsets.push(size);
 }
 const padded=new Uint8Array(size);let cursor=0;
 for(const chunk of chunks){padded.set(chunk,cursor);cursor+=chunk.length;}
 const newLoca=new Uint8Array((glyphs+1)*4),nv=new DataView(newLoca.buffer);
 paddedOffsets.forEach((n,i)=>nv.setUint32(i*4,n));
 records.find(t=>t.name==='glyf')!.data=padded;records.find(t=>t.name==='loca')!.data=newLoca;
 hv.setUint32(8,0);
 const align=(n:number)=>Math.ceil(n/4)*4;
 const out=new Uint8Array(12+count*16+records.reduce((n,r)=>n+align(r.data.length),0)),ov=new DataView(out.buffer);
 out.set(data.slice(0,12));cursor=12+count*16;let headOffset=0;
 const checksum=(bytes:Uint8Array)=>{let sum=0;for(let i=0;i<bytes.length;i+=4)sum=(sum+((bytes[i]??0)*0x1000000+(bytes[i+1]??0)*0x10000+(bytes[i+2]??0)*256+(bytes[i+3]??0)))>>>0;return sum;};
 records.forEach((record,i)=>{
  const p=12+i*16;out.set(Array.from(record.name,c=>c.charCodeAt(0)),p);ov.setUint32(p+4,checksum(record.data));ov.setUint32(p+8,cursor);ov.setUint32(p+12,record.data.length);
  out.set(record.data,cursor);if(record.name==='head')headOffset=cursor;cursor+=align(record.data.length);
 });
 ov.setUint32(headOffset+8,(0xb1b0afba-checksum(out))>>>0);
 return out;
}
