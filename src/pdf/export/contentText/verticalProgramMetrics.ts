function sfntTables(data:Uint8Array,view:DataView){
 const tables=new Map<string,{offset:number;length:number}>();
 if(data.length<12)return;
 const version=view.getUint32(0);
 if(version!==0x10000&&version!==0x4f54544f&&version!==0x74727565&&version!==0x74797031)return;
 const count=view.getUint16(4);if(12+count*16>data.length)return;
 for(let i=0;i<count;i++){
  const p=12+i*16,tag=String.fromCharCode(...data.slice(p,p+4)),offset=view.getUint32(p+8),length=view.getUint32(p+12);
  if(offset+length>data.length||tables.has(tag))return;tables.set(tag,{offset,length});
 }
 return tables;
}

/** Skip a horizontal-only local program. Partial or malformed tables still
 * go through the metric proof if the face wins selection. */
export function mayHaveVerticalMetrics(data:Uint8Array):boolean{
 const view=new DataView(data.buffer,data.byteOffset,data.byteLength);
 const tables=sfntTables(data,view);
 return !tables||tables.has('vhea')||tables.has('vmtx')||tables.has('VORG');
}

/** Read sfnt vertical metrics directly. vhea has a 32-bit version followed
 * by fifteen 16-bit fields; the last field is numberOfVMetrics. */
export function verticalProgramMetrics(data:Uint8Array){
 const fail=():never=>{throw Error('vertical-metrics: malformed or missing sfnt vertical tables');};
 const view=new DataView(data.buffer,data.byteOffset,data.byteLength),tables=sfntTables(data,view)??fail();
 const vhea=tables.get('vhea'),vmtx=tables.get('vmtx'),maxp=tables.get('maxp');
 if(!vhea||vhea.length<36||!vmtx||!maxp||maxp.length<6)fail();
 const metrics=view.getUint16(vhea!.offset+34),glyphs=view.getUint16(maxp!.offset+4);
 if(!metrics||metrics>glyphs||vmtx!.length<metrics*4+(glyphs-metrics)*2)fail();
 const origins=new Map<number,number>(),vorg=tables.get('VORG');let defaultOrigin:number|undefined;
 if(vorg){
  if(vorg.length<8||view.getUint32(vorg.offset)!==0x10000)fail();
  defaultOrigin=view.getInt16(vorg.offset+4);const n=view.getUint16(vorg.offset+6);
  if(8+n*4>vorg.length)fail();
  for(let i=0;i<n;i++){const p=vorg.offset+8+i*4,gid=view.getUint16(p);if(gid>=glyphs||origins.has(gid))fail();origins.set(gid,view.getInt16(p+2));}
 }
 return(gid:number,top:number)=>{
  if(!Number.isInteger(gid)||gid<0||gid>=glyphs)fail();
  const p=vmtx!.offset+Math.min(gid,metrics-1)*4,advance=view.getUint16(p);
  const bearing=view.getInt16(gid<metrics?p+2:vmtx!.offset+metrics*4+(gid-metrics)*2);
  if(!advance)fail();return{advance,origin:origins.get(gid)??defaultOrigin??top+bearing};
 };
}
