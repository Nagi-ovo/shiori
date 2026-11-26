import { codeHex, hexBytes } from './types';
import { codeInCodespace } from './codespace';
export type ParsedCMap = {
  unicode: Map<string,string>;
  cids: Map<string,number>;
  codeSpaces: { low: string; high: string }[];
  vertical: boolean;
  identity: boolean;
};
const LIMIT = 65536;
function unicode(hex: string): string {
  if (!hex.length || hex.length % 4) throw new Error('invalid UTF-16BE destination');
  let value='';
  for(let i=0;i<hex.length;i+=4) value+=String.fromCharCode(parseInt(hex.slice(i,i+4),16));
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) throw new Error('invalid UTF-16BE surrogate');
  return value;
}
/** Bounded parser for the mapping operators, not a PostScript evaluator. */
export function parseCMap(source: string): ParsedCMap {
  if (source.length > 8_000_000) throw new Error('CMap too large');
  const tokens=source.match(/%[^\r\n]*|\((?:\\.|[^\\)])*\)|<<|>>|<[^>]*>|\[|\]|[^\s<>[\]()%]+|[<>]/g) ?? [];
  const t=tokens.filter(x=>!x.startsWith('%'));
  const result: ParsedCMap={unicode:new Map(),cids:new Map(),codeSpaces:[],vertical:false,identity:false};
  const hex=(i:number): string => {
    const value=t[i];
    if (!value || !/^<(?:[0-9a-fA-F\s]+)>$/.test(value)) throw new Error('invalid CMap hex');
    const compact=value.slice(1,-1).replace(/\s/g,'').toLowerCase();
    if (compact.length%2) throw new Error('odd CMap hex');
    return compact;
  };
  const code=(i:number):string=>{const h=hex(i);if(h.length>8)throw new Error('code wider than four bytes');return h;};
  const number=(i:number):number=>{const s=t[i];if(!s || !/^\d+$/.test(s) || +s>65535)throw new Error('invalid CID');return +s;};
  let total=0;
  for(let i=0;i<t.length;i++) {
    const op=t[i]!;
    if(op==='/WMode' && t[i+2]==='def')result.vertical=t[i+1]==='1';
    if(op==='usecmap') {
      if(t[i-1]==='/Identity-H' || t[i-1]==='/Identity-V') {result.identity=true;result.vertical=t[i-1]==='/Identity-V';}
      else throw new Error('unsupported predefined CMap / usecmap');
    }
    const ends:Record<string,string>={beginbfchar:'endbfchar',beginbfrange:'endbfrange',begincidchar:'endcidchar',begincidrange:'endcidrange',begincodespacerange:'endcodespacerange'};
    const end=ends[op];
    if(!end) {if(/^end(bfchar|bfrange|cidchar|cidrange|codespacerange)$/.test(op))throw new Error('unmatched CMap end');continue;}
    const count=Number(t[i-1]);
    if(!Number.isInteger(count) || count<0 || count>LIMIT)throw new Error('invalid CMap count');
    i++;
    for(let n=0;n<count;n++) {
      const low=code(i++);
      if(op==='beginbfchar') {result.unicode.set(low,unicode(hex(i++)));total++;}
      else if(op==='begincidchar') {result.cids.set(low,number(i++));total++;}
      else {
        const high=code(i++), lo=parseInt(low,16),hi=parseInt(high,16),span=hi-lo+1;
        if(low.length!==high.length || span<1)throw new Error('invalid CMap range');
        if(op==='begincodespacerange') {result.codeSpaces.push({low,high});continue;}
        if(span>LIMIT)throw new Error('invalid CMap range');
        if(total+span>LIMIT*4)throw new Error('CMap mapping limit');
        if(op==='begincidrange') {
          const base=number(i++);if(base+span-1>65535)throw new Error('invalid CID range');
          for(let k=0;k<span;k++)result.cids.set((lo+k).toString(16).padStart(low.length,'0'),base+k);
        } else if(t[i]==='[') {
          i++;
          for(let k=0;k<span;k++)result.unicode.set((lo+k).toString(16).padStart(low.length,'0'),unicode(hex(i++)));
          if(t[i++]!==']')throw new Error('CMap array length mismatch');
        } else {
          const dest=hex(i++), bytes=hexBytes(dest);
          for(let k=0;k<span;k++) {
            result.unicode.set((lo+k).toString(16).padStart(low.length,'0'),unicode(codeHex(bytes)));
            if(k+1<span) {
              let p=bytes.length-1;
              while(p>=0 && bytes[p]===255){bytes[p]=0;p--;}
              if(p<0)throw new Error('CMap destination overflow');bytes[p]=bytes[p]!+1;
            }
          }
        }
        total+=span;
      }
      if(total>LIMIT*4)throw new Error('CMap mapping limit');
    }
    if(t[i]!==end)throw new Error(`unterminated or malformed ${op}`);
  }
  for(const key of [...result.unicode.keys(),...result.cids.keys()]) {
    if(result.codeSpaces.length && !result.codeSpaces.some(s=>codeInCodespace(key,s.low,s.high)))throw new Error('code outside codespace');
  }
  return result;
}
