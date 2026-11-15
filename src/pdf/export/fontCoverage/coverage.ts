import { stage5Type1, rejectType1 } from './type1Support';
import type { Type1Options } from './type1Support';
import { fillType1Coverage, recordType1Error } from './type1Mapping';
import { parseCMap } from './cmap';
import { glyphUnicode, simpleNames, standardBuiltIn, standardFont } from './encodings';
import { readProgram } from './program';
import { codeHex, codeNumber, hexBytes } from './types';
import type { EncodeOptions, EncodeResult, FontCoverage, FontInput } from './types';
export type { FontCoverage, FontInput, EncodeOptions, EncodeResult } from './types';

function encoder(report:FontCoverage,text:string,options:EncodeOptions={}):EncodeResult {
  if(report.replacementDisabled)return {ok:false,reason:report.replacementDisabled,firstMissing:Array.from(text)[0]??'',offset:0};
  if(text) {
    const diagnostic=report.failures?.find(d=>d.code==='glyph-identity-conflict'&&d.cluster&&text.includes(d.cluster))
      ??report.failures?.find(d=>!d.hex)??report.failures?.find(d=>d.cluster&&text.includes(d.cluster));
    if(diagnostic)return {ok:false,reason:`${diagnostic.code}: ${diagnostic.detail}`,code:diagnostic.code,detail:diagnostic.detail,data:diagnostic.data,terminal:diagnostic.code!=='glyph-unavailable',firstMissing:diagnostic.cluster??Array.from(text)[0]??'',offset:diagnostic.cluster?text.indexOf(diagnostic.cluster):0};
  }
  if(!text)return {ok:true,codes:[],bytes:new Uint8Array(),preferredApplied:!options.preferredCodes?.length};
  const byFirst=new Map<string,string[]>();
  for(const key of report.encodable.keys()) {const c=key[0]!;const values=byFirst.get(c) ?? [];values.push(key);byFirst.set(c,values);}
  for(const values of byFirst.values())values.sort((a,b)=>b.length-a.length);
  // Dynamic programming avoids greedy ligature matches stranding a suffix.
  const next=new Map<number,{cluster:string;end:number}>();
  const good=new Set([text.length]);
  for(let i=text.length-1;i>=0;i--)for(const cluster of byFirst.get(text[i]!) ?? []) {
    const end=i+cluster.length;
    if(text.startsWith(cluster,i) && good.has(end)) {next.set(i,{cluster,end});good.add(i);break;}
  }
  if(!good.has(0)) {
    const reachable=new Set([0]);let furthest=0;
    for(let i=0;i<text.length;i++)if(reachable.has(i)) {
      furthest=Math.max(furthest,i);
      for(const cluster of byFirst.get(text[i]!) ?? [])if(text.startsWith(cluster,i))reachable.add(i+cluster.length);
    }
    const firstMissing=new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text.slice(furthest))[Symbol.iterator]().next().value?.segment ?? '';
    const reason=report.missing.find(m=>m.cluster===firstMissing)?.reason ?? report.missing.find(m=>!m.code)?.reason ?? 'no verified source code for cluster';
    return {ok:false,reason,firstMissing,offset:furthest,...(report.mappings?{code:'glyph-unavailable' as const,terminal:false}:{})};
  }
  const codes:Uint8Array[]=[];
  let preferredApplied=true;
  for(let i=0;i<text.length;) {
    const step=next.get(i)!,candidates=report.encodable.get(step.cluster)!;
    const preferred=options.preferredCodes?.[codes.length];
    const matched=preferred && candidates.find(c=>codeHex(c)===codeHex(preferred));
    if(options.preferredCodes && !matched)preferredApplied=false;
    const code=matched || candidates[0]!;
    codes.push(code.slice());i=step.end;
  }
  const bytes=new Uint8Array(codes.reduce((n,c)=>n+c.length,0));let offset=0;
  for(const code of codes){bytes.set(code,offset);offset+=code.length;}
  if(options.preferredCodes && options.preferredCodes.length!==codes.length)preferredApplied=false;
  return {ok:true,codes,bytes,preferredApplied};
}
/** Resolve Unicode → existing PDF codes only after independently verifying the
 * rendering code → glyph path. No shaping, font growth, or width calculation. */
export function createFontCoverage(input:FontInput,options:Type1Options={}):FontCoverage {
  const baseFont=input.baseFont ?? '';
  const report:FontCoverage={subtype:input.subtype,baseFont,subsetTag:/^([A-Z]{6})\+/.exec(baseFont)?.[1] ?? null,
    encodingKind:typeof input.encoding==='string'?input.encoding:input.encoding?.cmap?'embedded CMap':input.encoding?.base ?? 'built-in',
    vertical:false,verification:'unverified',warnings:[],missing:[],codeToUnicode:new Map(),encodable:new Map(),glyphIds:new Map(),definedCodes:[],
    canEncode:(text,options)=>encoder(report,text,options)};
  try {
    if(input.subtype==='MMType1')rejectType1('type1-ps-unsupported','MMType1 interpolation');
    if(input.diagnostic)rejectType1(input.diagnostic.code,input.diagnostic.detail,input.diagnostic.data);
    if(input.error)throw new Error(input.error);
    if(!['Type1','MMType1','TrueType','Type0','Type3'].includes(input.subtype))throw new Error(`unsupported font subtype ${input.subtype}`);
    const type0=input.subtype==='Type0',type3=input.subtype==='Type3';
    const standard=!input.program && !type0 && !type3?standardFont(baseFont):undefined;
    if(input.subtype==='Type1'&&!input.program&&!standard)rejectType1('font-program-missing','font program not embedded');
    const program=(!standard && !type3)?readProgram(input):undefined;
    report.verification=type3?'defined-type3':standard?'assumed-standard':'verified';
    if(standard)report.warnings.push('non-embedded standard font');
    if(type3)report.warnings.push('type3: encode only codes already defined in /CharProcs');
    if(program?.kind==='type1'||(standard&&(options.standard14Afm??stage5Type1.standard14Afm))) {
      fillType1Coverage(report,input,program?.kind==='type1'?program:undefined);
      if(program?.kind==='type1'&&!(options.sourceReuse??stage5Type1.sourceReuse)){
        report.replacementDisabled='Stage-5 Type1 source reuse is disabled';
        report.verification='unverified';report.missing.unshift({reason:report.replacementDisabled});
      }
      return report;
    }
    const builtIn=standard?standardBuiltIn(baseFont):program?.builtIn;
    const names=type0?new Map<number,string>():program?.symbolic && !program.cff?program.builtIn:simpleNames(input,builtIn);
    const unicodeMap=input.toUnicode===undefined?new Map<string,string>():parseCMap(input.toUnicode).unicode;
    if(input.toUnicode===undefined && !type0)for(const [code,name] of names) {
      const value=glyphUnicode(name);if(value)unicodeMap.set(code.toString(16).padStart(2,'0'),value);
    }
    report.codeToUnicode=unicodeMap;
    if(!type0 && program?.kind==='fontkit' && program.symbolic && !program.cff && input.toUnicode===undefined)
      report.replacementDisabled='missing-tounicode: symbolic replacement requires a ToUnicode label and verified glyph name';
    if(type0 && !unicodeMap.size)throw new Error('missing ToUnicode for CID font');
    let codeCid:(hex:string)=>number|undefined=()=>undefined;
    if(type0) {
      const enc=input.encoding;
      if(enc==='Identity-H' || enc==='Identity-V') {
        report.vertical=enc==='Identity-V';codeCid=hex=>hex.length===4?codeNumber(hex):undefined;
      } else if(typeof enc==='object' && enc.cmap) {
        const parsed=parseCMap(enc.cmap);report.vertical=parsed.vertical;
        codeCid=hex=>parsed.cids.get(hex) ?? (parsed.identity && hex.length===4?codeNumber(hex):undefined);
      } else throw new Error('unsupported predefined CMap');
      if(!['CIDFontType2','CIDFontType0'].includes(input.cidSubtype ?? ''))throw new Error('unsupported CID font subtype');
      if(input.cidSubtype==='CIDFontType2' && program?.cff)throw new Error('CIDFontType2 requires TrueType glyf program');
      if(input.cidSubtype==='CIDFontType0' && !program?.cid)throw new Error('CIDFontType0 requires CID-keyed CFF program');
      if(input.cidToGid instanceof Uint8Array && input.cidToGid.length%2)throw new Error('truncated CIDToGIDMap stream');
    }
    if(type3)for(const [code,name] of names)if(input.charProcs?.includes(name))report.definedCodes.push(Uint8Array.of(code));
    for(const [hex,cluster] of unicodeMap) {
      let reason:string|undefined;
      if(type3) {
        if(hex.length!==2 || !input.charProcs?.includes(names.get(codeNumber(hex)) ?? ''))reason='code not defined in /CharProcs';
      } else if(standard) {
        const name=names.get(codeNumber(hex));
        if(hex.length!==2 || !name || name==='.notdef' || standard.getWidthOfGlyph(name)===undefined)reason='glyph not in standard font';
      } else {
        let gid=0;
        if(type0) {
          const cid=codeCid(hex);
          if(cid===undefined)reason='code not mapped to CID';
          else if(input.cidSubtype==='CIDFontType0')gid=program!.cidGid(cid);
          else if(input.cidToGid instanceof Uint8Array) {
            const offset=cid*2,map=input.cidToGid;
            gid=offset+1<map.length?map[offset]!*256+map[offset+1]!:0;
          } else gid=cid;
        } else if(hex.length!==2)reason='simple font code must be one byte';
        else {
          const selected=program!.simpleGid(codeNumber(hex),names.get(codeNumber(hex)));
          if(typeof selected==='number')gid=selected;
          else reason=selected.reason;
        }
        if(!reason)report.glyphIds.set(hex,gid);
        reason ??= program!.presence(gid,cluster);
        if(!reason && !type0 && program!.symbolic && !program!.cff) {
          const name=names.get(codeNumber(hex));
          if(input.toUnicode===undefined || !name)reason='missing-tounicode: symbolic replacement requires a ToUnicode label and verified glyph name';
          else if(glyphUnicode(name)!==cluster)reason='glyph-identity-conflict: symbolic glyph name disagrees with ToUnicode';
        }
      }
      if(reason)report.missing.push({code:hex,cluster,reason});
      else {
        const values=report.encodable.get(cluster) ?? [];
        values.push(hexBytes(hex));report.encodable.set(cluster,values);
      }
    }
    for(const values of report.encodable.values())values.sort((a,b)=>a.length-b.length || codeHex(a).localeCompare(codeHex(b)));
  } catch(error) {
    recordType1Error(report,error);
    report.encodable.clear();report.verification='unverified';
    report.missing.push({reason:error instanceof Error?error.message:String(error)});
  }
  return report;
}
