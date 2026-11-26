import {address} from './retypesetSource';
import type {RetypesetCluster,RetypesetGroup} from './retypesetTypes';

/** Matching only. Each scalar retains its original UTF-16 interval; callers
 * attach glyph homes using that interval. Never normalize written text here. */
export type CompactChar={char:string;start:number;end:number};
export function compactMap(text:string,dehyphenate=false,lineBreaks:ReadonlySet<number>=new Set()):CompactChar[]{
 const chars:CompactChar[]=[];
 let start=0;
 for(const raw of text){
  const end=start+raw.length;
  const gap=dehyphenate&&raw==='-'?text.slice(end).match(/^\s*/u)![0]:'';
  const lineEnd=dehyphenate&&raw==='-'&&(/[\r\n]/u.test(gap)||[...lineBreaks].some(b=>b>=end&&b<=end+gap.length));
  // U+0002 is PDFium's discretionary-hyphen marker. Retain its hyphen
  // spelling first; a second matching pass may omit discretionary hyphens.
  if(!/\s/u.test(raw)&&raw!=='\u00ad'&&!(dehyphenate&&(raw==='\u0002'||raw==='-'&&lineEnd)))
   chars.push({char:raw==='\u0002'?'-':raw,start,end});
  start=end;
 }
 return chars;
}

/** Number of compact scalars before an original UTF-16 boundary. Folding
 * uses the full string, so a prefix ending before a newline stays reversible. */
export function compactOffset(chars:readonly CompactChar[],original:number){
 let lo=0,hi=chars.length;
 while(lo<hi){const mid=(lo+hi)>>>1;if(chars[mid]!.start<original)lo=mid+1;else hi=mid;}
 return lo;
}
export type CompactGlyph=CompactChar&{atom:number;offset:number;wildcard:boolean};
/** Inferred interline spaces stay spaces in the output. Their line identity
 * supplies matching-only line breaks for discretionary hyphen recognition. */
export function compactGlyphs(atoms:RetypesetCluster[],group:RetypesetGroup,dehyphenate=false):CompactGlyph[]{
 const lines=new Map(group.lines.flatMap((line,i)=>line.glyphs.map(g=>[address(g.glyph),i]as const)));
 const starts:number[]=[],breaks=new Set<number>();let text='',previous:number|undefined;
 for(const a of atoms){
  const line=lines.get(address(a.home.glyph));
  if(previous!==undefined&&line!==previous)breaks.add(text.length);
  starts.push(text.length);text+=a.text;previous=line;
 }
 let atom=0;
 return compactMap(text,dehyphenate,breaks).map(c=>{
  while(atom+1<atoms.length&&starts[atom+1]!<=c.start)atom++;
  return{...c,atom,offset:c.start-starts[atom]!,wildcard:!!atoms[atom]!.bytes&&(atoms[atom]!.home.text===undefined||c.char==='\ufffd')};
 });
}
