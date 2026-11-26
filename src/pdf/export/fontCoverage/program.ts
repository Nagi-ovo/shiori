import fontkit from '@pdf-lib/fontkit';
import { readType1Program } from './type1Program';
import { rejectType1 } from './type1Support';
import { cffEncodingOffset } from './cffEncodingOffset';
import type { Font } from '@pdf-lib/fontkit';
import { glyphUnicode, macOsNames, standardNames } from './encodings';
import type { FontInput } from './types';
import { trueTypeCmaps, symbolicGid } from './trueTypeCmap';
type Cff = {isCIDFont:boolean;topDict:{charset:string[] | {version:number;glyphs:number[];ranges:{first:number;nLeft:number;offset:number}[]};CharStrings:{offset:number;length:number}[];Encoding:string[] | {version:number;codes:number[];ranges:{first:number;nLeft:number}[]}};getGlyphName(gid:number):string|null;getCharString(gid:number):Uint8Array};
type ParsedFont = Font & {
  directory:{tables:Record<string,{offset:number;length:number}>};
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
export function readProgram(input:FontInput) {
  if(input.subtype==='MMType1')rejectType1('type1-ps-unsupported','MMType1 interpolation');
  if(!input.program)throw new Error('font program not embedded');
  const raw=input.program;
  const isRawCff=raw[0]===1 && raw[2]!>=4;
  if(input.programKind==='FontFile' || raw[0]===0x25 || raw[0]===0x80)return readType1Program(input);
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
  const table=trueTypeCmaps(data,font.directory.tables.cmap);
  // Keep selection lazy: an unselected unsupported cmap grants no eligibility.
  const flags=input.flags ?? 0;
  const encodingName=typeof input.encoding==='string'?input.encoding:input.encoding?.base;
  const standardEncoding=['WinAnsiEncoding','MacRomanEncoding','StandardEncoding','MacExpertEncoding'].includes(encodingName ?? '');
  const bothFlagsWithEncoding=(flags & 36)===36 && standardEncoding;
  const symbolic=!bothFlagsWithEncoding && (!!(flags & 4) || (!input.encoding && !(flags & 32)));
  const symbol=!cff && symbolic?table(3,0):undefined;
  const unicode=!cff && !symbolic?table(3,1):undefined;
  const mac=!cff && !symbol && !unicode?table(1,0):undefined;
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
      // Fontkit masks bit 7 and does not decode supplements. Its decoded
      // record retains the absolute start offset; inspect the original byte.
      const table=font.directory.tables['CFF ']!;
      const start=cffEncodingOffset(enc,table);
      if(data[start]! & 0x80)throw new Error('unsupported CFF encoding supplements');
      builtIn=new Map();let gid=1;
      const put=(code:number)=>{const name=cff.getGlyphName(gid++);if(name)builtIn.set(code,name);};
      if(enc.version===0)for(const code of enc.codes)put(code);
      else if(enc.version===1)for(const r of enc.ranges)for(let k=0;k<=r.nLeft;k++)put(r.first+k);
      else throw new Error('unsupported CFF built-in encoding');
    }
  }
  // A symbolic font's PDF Encoding is ignored. Without ToUnicode, only
  // names established by its actual cmap/post mapping identify text safely.
  if(symbolic && !cff) {
    builtIn=new Map();
    for(let code=0;code<256;code++) {
      if(symbol) {
        const gid=symbolicGid(symbol,code);
        if(typeof gid==='number' && gid>0 && gid<numGlyphs) {
          const name=(font.getGlyph(gid) as unknown as {name?:string}).name;
          if(name)builtIn.set(code,name);
        }
      } else if(mac && (mac(code) ?? 0)) {
        const name=macOsNames.get(code);if(name)builtIn.set(code,name);
      }
    }
  }
  const simpleGid=(code:number,name:string|undefined):number | {reason:string}=>{
    if(cff)return name?names.get(name) ?? 0:0;
    if(symbolic) {
      if(symbol) {
        return symbolicGid(symbol,code);
      }
      if(mac)return (mac(code) ?? 0);
      return {reason:'symbolic-cmap-unsupported: No supported symbolic cmap'};
    }
    if(!name)return 0;
    const value=glyphUnicode(name);
    if(unicode && value && Array.from(value).length===1) {const gid=unicode(value.codePointAt(0)!);if(gid)return gid;}
    else if(!unicode && mac) {
      const entry=[...macOsNames].find(([,n])=>n===name);
      if(entry){const gid=mac(entry[0]);if(gid)return gid;}
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
  const inkBox=(gid:number)=>{
    if(cff || !Number.isFinite(font.unitsPerEm) || font.unitsPerEm<=0)return;
    const glyph=font.getGlyph(gid);
    // Real subsets may retain a nonzero glyf header bbox for an empty path.
    // Fontkit exposes that stale cbox even though the glyph paints nothing.
    if(!glyph.path.toSVG())return {x:0,y:0,w:0,h:0};
    const b=glyph.cbox,u=font.unitsPerEm;
    return {x:b.minX/u,y:b.minY/u,w:(b.maxX-b.minX)/u,h:(b.maxY-b.minY)/u};
  };
  return {kind:'fontkit' as const,inkBox,numGlyphs,symbolic,cff:!!cff,cid:!!cff?.isCIDFont,builtIn,simpleGid,cidGid:(cid:number)=>cidToGid.get(cid) ?? 0,presence};
}
