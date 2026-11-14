import fontkit from '@pdf-lib/fontkit';
import type { Font } from '@pdf-lib/fontkit';
import { glyphUnicode, macOsNames, standardNames } from './encodings';
import type { FontInput } from './types';
type Values<T> = { get(index:number):T; length:number };
type CmapTable = {version:number;codeMap:Values<number>;firstCode:number;glyphIndices:Values<number>;segCount:number;startCode:Values<number>;endCode:Values<number>;idRangeOffset:Values<number>;idDelta:Values<number>;glyphIndexArray:Values<number>;nGroups:number;groups:Values<{startCharCode:number;endCharCode:number;glyphID:number}>};
type Cff = {isCIDFont:boolean;topDict:{charset:string[] | {version:number;glyphs:number[];ranges:{first:number;nLeft:number;offset:number}[]};CharStrings:{offset:number;length:number}[];Encoding:string[] | {version:number;codes:number[];ranges:{first:number;nLeft:number}[];supplement?:{code:number;glyph:number}[]}};getGlyphName(gid:number):string|null;getCharString(gid:number):Uint8Array};
type ParsedFont = Font & {
  directory:{tables:Record<string,{offset:number;length:number}>};
  cmap?:{tables:{platformID:number;encodingID:number;table:CmapTable}[]};
  loca:{offsets:number[]};
  'CFF '?:Cff;
};
/** fontkit has no standalone CFF entry point. Supply only container metadata;
 * the CFF interpreter still parses the original, unmodified program bytes. */
function wrapCff(bytes:Uint8Array):Uint8Array {
  const head=new Uint8Array(54);new DataView(head.buffer).setUint16(18,1000);
  const maxp=Uint8Array.of(0,0,0x50,0,0xff,0xff);
  const tables:[string,Uint8Array][]=[['CFF ',bytes],['head',head],['maxp',maxp]];
  const size=60+tables.reduce((n,[,b])=>n+Math.ceil(b.length/4)*4,0);
  const out=new Uint8Array(size),v=new DataView(out.buffer);out.set([79,84,84,79]);v.setUint16(4,3);
  let offset=60;
  tables.forEach(([name,b],i)=>{const r=12+i*16;out.set(Array.from(name,c=>c.charCodeAt(0)),r);v.setUint32(r+8,offset);v.setUint32(r+12,b.length);out.set(b,offset);offset+=Math.ceil(b.length/4)*4;});
  return out;
}
function lookup(t:CmapTable,cp:number):number {
  if(t.version===0)return cp<256?t.codeMap.get(cp) || 0:0;
  if(t.version===6 || t.version===10) {
    const i=cp-t.firstCode;return i>=0 && i<t.glyphIndices.length?t.glyphIndices.get(i) || 0:0;
  }
  if(t.version===4) {
    for(let i=0;i<t.segCount;i++)if(cp>=t.startCode.get(i) && cp<=t.endCode.get(i)) {
      const off=t.idRangeOffset.get(i),delta=t.idDelta.get(i);
      if(!off)return (cp+delta)&65535;
      const index=off/2+cp-t.startCode.get(i)-(t.segCount-i);
      const gid=index>=0 && index<t.glyphIndexArray.length?t.glyphIndexArray.get(index):0;
      return gid?(gid+delta)&65535:0;
    }
    return 0;
  }
  if(t.version===12 || t.version===13) {
    for(let i=0;i<t.nGroups;i++){const g=t.groups.get(i);if(cp>=g.startCharCode && cp<=g.endCharCode)return g.glyphID+(t.version===12?cp-g.startCharCode:0);}
    return 0;
  }
  throw new Error(`unsupported TrueType cmap format ${t.version}`);
}
export function readProgram(input:FontInput) {
  if(!input.program)throw new Error('font program not embedded');
  const raw=input.program;
  const isRawCff=raw[0]===1 && raw[2]!>=4;
  if(input.programKind==='FontFile' || raw[0]===0x25 || raw[0]===0x80)throw new Error('unsupported Type1 font program');
  const data=isRawCff?wrapCff(raw):raw;
  if(data.length<12)throw new Error('malformed font program: truncated header');
  const view=new DataView(data.buffer,data.byteOffset,data.byteLength),count=view.getUint16(4);
  if(count>256 || 12+count*16>data.length)throw new Error('malformed font program: table directory');
  for(let i=0;i<count;i++) {const p=12+i*16,off=view.getUint32(p+8),len=view.getUint32(p+12);if(off+len>data.length)throw new Error('malformed font program: truncated table');}
  const font=fontkit.create(data) as ParsedFont;
  const cff=font['CFF '];
  const numGlyphs=cff?cff.topDict.CharStrings.length:font.numGlyphs;
  if(!Number.isInteger(numGlyphs) || numGlyphs<1 || numGlyphs>65535)throw new Error('malformed font program: glyph count');
  const names=new Map<string,number>();
  for(let gid=1;gid<numGlyphs;gid++) {
    const name=cff?cff.getGlyphName(gid):(font.getGlyph(gid) as unknown as {name?:string}).name;
    if(name)names.set(name,gid);
  }
  const tables=font.cmap?.tables ?? [];
  const table=(p:number,e:number)=>tables.find(t=>t.platformID===p && t.encodingID===e)?.table;
  const unicode=table(3,1),mac=table(1,0),symbol=table(3,0);
  const cidToGid=new Map<number,number>();
  if(cff?.isCIDFont) {
    const charset=cff.topDict.charset;
    if(Array.isArray(charset))throw new Error('invalid CID CFF charset');
    if(charset.version===0)charset.glyphs.forEach((cid,i)=>cidToGid.set(cid,i+1));
    else if(charset.version===1 || charset.version===2)for(const r of charset.ranges)for(let k=0;k<=r.nLeft;k++)cidToGid.set(r.first+k,r.offset+k+1);
    else throw new Error('unsupported CFF charset');
  }
  let builtIn=new Map(standardNames);
  if(cff && !cff.isCIDFont) {
    const enc=cff.topDict.Encoding;
    if(Array.isArray(enc))builtIn=new Map(enc.map((name,i)=>[i,name]));
    else {
      builtIn=new Map();let gid=1;
      const put=(code:number)=>{const name=cff.getGlyphName(gid++);if(name)builtIn.set(code,name);};
      if(enc.version===0)for(const code of enc.codes)put(code);
      else if(enc.version===1)for(const r of enc.ranges)for(let k=0;k<=r.nLeft;k++)put(r.first+k);
      else throw new Error('unsupported CFF built-in encoding');
      if(enc.supplement?.length)throw new Error('unsupported CFF encoding supplements');
    }
  }
  const symbolic=!!((input.flags ?? 0)&4) || (!input.encoding && !((input.flags ?? 0)&32));
  // A symbolic font's PDF Encoding is ignored. Without ToUnicode, only
  // names established by its actual cmap/post mapping identify text safely.
  if(symbolic && !cff) {
    builtIn=new Map();
    for(let code=0;code<256;code++) {
      if(symbol) {
        const gids=[0,0xf000,0xf100,0xf200].map(h=>lookup(symbol,h+code)).filter(Boolean);
        if(gids.length===1) {
          const name=(font.getGlyph(gids[0]!) as unknown as {name?:string}).name;
          if(name)builtIn.set(code,name);
        }
      } else if(mac && lookup(mac,code)) {
        const name=macOsNames.get(code);if(name)builtIn.set(code,name);
      }
    }
  }
  const simpleGid=(code:number,name:string|undefined):number=>{
    if(cff)return name?names.get(name) ?? 0:0;
    if(symbolic) {
      if(symbol) {
        // The permitted symbol range occupies one high-byte block. Refuse
        // ambiguity rather than borrowing a glyph from another cmap.
        const candidates=[0,0xf000,0xf100,0xf200].map(h=>lookup(symbol,h+code)).filter(Boolean);
        if(candidates.length>1)throw new Error('ambiguous symbolic TrueType cmap');
        return candidates[0] ?? 0;
      }
      if(mac)return lookup(mac,code);
      throw new Error('unsupported symbolic TrueType cmap');
    }
    if(!name)return 0;
    const value=glyphUnicode(name);
    if(unicode && value && Array.from(value).length===1) {const gid=lookup(unicode,value.codePointAt(0)!);if(gid)return gid;}
    else if(!unicode && mac) {
      const entry=[...macOsNames].find(([,n])=>n===name);
      if(entry){const gid=lookup(mac,entry[0]);if(gid)return gid;}
    }
    return names.get(name) ?? 0;
  };
  const presence=(gid:number,cluster:string):string|undefined=>{
    if(!gid)return '.notdef (GID 0)';
    if(!Number.isInteger(gid) || gid<0 || gid>=numGlyphs)return 'GID outside font program';
    if(cff) {
      const char=cff.topDict.CharStrings[gid];
      const table=font.directory.tables['CFF ']!;
      if(!char || !char.length || char.offset<table.offset || char.offset+char.length>table.offset+table.length || cff.getCharString(gid).length!==char.length)return 'missing CFF charstring';
      return;
    }
    if(!font.directory.tables.glyf || !font.directory.tables.loca)return 'font program missing glyf/loca';
    const a=font.loca.offsets[gid],b=font.loca.offsets[gid+1];
    if(a===undefined || b===undefined || a<0 || b<a || b>font.directory.tables.glyf.length)return 'invalid glyf entry';
    // Empty glyphs do not need ink; Unicode separators, marks and formatting
    // controls are explicitly allowed to occupy an empty loca slot.
    if(a===b)return /^[\p{White_Space}\p{M}\p{Cf}]+$/u.test(cluster)?undefined:'absent subset glyf entry';
    if(b-a<10)return 'truncated glyf entry';
    void font.getGlyph(gid).path;
  };
  return {numGlyphs,symbolic,cff:!!cff,cid:!!cff?.isCIDFont,builtIn,simpleGid,cidGid:(cid:number)=>cidToGid.get(cid) ?? 0,presence};
}
