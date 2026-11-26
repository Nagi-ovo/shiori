import {address} from './retypesetSource';
import {lineChanges} from './diff';
import type {RetypesetCluster,RetypesetEdit,RetypesetGroup} from './retypesetTypes';
import {compactMap,compactOffset,compactGlyphs,type CompactGlyph,type CompactChar} from './retypesetCompact';

type Char=CompactGlyph;
const matches=(c:Char,wanted:CompactChar|undefined)=>!!wanted&&(c.wildcard||c.char===wanted.char);
const discretionary=(c:string)=>c==='\u0002'||c==='\u00ad'||c==='-';
const onlyDiscretionary=(s:string)=>!!s&&Array.from(s).every(discretionary);

/** PDFium can omit a superscript or a lowered logo letter. Only a complete
 * selected span may skip such glyphs, and only with independent size/baseline
 * evidence. Ordinary letters and unselected neighbours remain mandatory. */
function optionalSpan(atoms:RetypesetCluster[],lo:number,hi:number,chars:Char[],wanted:CompactChar[],group:RetypesetGroup,selected:ReadonlySet<string>){
 const optional=new Set<string>();
 for(const line of group.lines){
  const middle=Math.floor(line.glyphs.length/2),size=line.glyphs.map(g=>g.state.fontSize).sort((a,b)=>a-b)[middle]!,y=line.glyphs.map(g=>g.y).sort((a,b)=>a-b)[middle]!;
  for(const g of line.glyphs)if(g.state.fontSize<size*.85||Math.abs(g.y-y)>size*.1)optional.add(address(g.glyph));
 }
 const tokens=new Map<number,Char[]>();
 for(const c of chars)if(c.atom>=lo&&c.atom<hi){const token=tokens.get(c.atom)??[];token.push(c);tokens.set(c.atom,token);}
 let paths=new Map<number,Char[]>([[0,[]]]);
 for(let i=lo;i<hi;i++){
  const token=tokens.get(i)??[];
  if(!token.length)continue;
  const key=address(atoms[i]!.home.glyph),next=optional.has(key)&&selected.has(key)?new Map(paths):new Map<number,Char[]>();
  for(const [at,matched]of paths)if(token.every((c,j)=>matches(c,wanted[at+j])))next.set(at+token.length,[...matched,...token]);
  paths=next;
  if(!paths.size)return;
 }
 return paths.get(wanted.length);
}

/** Geometry locates; immutable glyph identities authorize deletion. Compact
 * scalar indices map back to atoms and UTF-16 offsets, including ligatures. */
export function selectedRange(atoms:RetypesetCluster[],edit:RetypesetEdit,group:RetypesetGroup):{range:[number,number];replacement:string;editedAtom:number}{
 const selected=new Set(edit.selected.map(g=>address(g.glyph))),hits=atoms.flatMap((a,i)=>a.bytes&&selected.has(address(a.home.glyph))?[i]:[]);
 if(!hits.length)throw Error('selection has no paragraph glyphs');
 const lo=hits[0]!,hi=hits.at(-1)!+1;
 const finish=(matched:Char[],whole:boolean,originalChars:CompactChar[]):ReturnType<typeof selectedRange>=>{
  const first=matched[0]!,last=matched.at(-1)!,changes=lineChanges(edit.overlay.originalText,edit.overlay.text);
  const range:[number,number]=whole?[lo,hi]:[first.atom,last.atom+1],offsets=new Map<number,number>();
  let replacement='';
  for(let i=range[0];i<range[1];i++){offsets.set(i,replacement.length);replacement+=atoms[i]!.text;}
  const begin=(c:Char)=>offsets.get(c.atom)!+c.offset,end=(c:Char)=>begin(c)+c.end-c.start;
  const touched=new Set<number>();
  // Map the user's changes, not the UI's incidental whitespace, onto source
  // atoms. Unchanged spaces/omitted logo or footnote glyphs retain their homes.
  const patches=changes.map(change=>{
   const before=compactOffset(originalChars,change.start),after=compactOffset(originalChars,change.end);
   for(let i=before;i<after;i++)touched.add(i);
   // A removed discretionary marker has no compact scalar. Its source
   // counterpart, if present, lies between the adjacent mapped glyphs.
   // Keep the source separator once, even when PDFium dropped the hyphen.
   if(before===after&&onlyDiscretionary(edit.overlay.originalText.slice(change.start,change.end))){
    const from=before?end(matched[before-1]!):0,to=before<matched.length?begin(matched[before]!):replacement.length;
    return{from,to,text:change.replacement+Array.from(replacement.slice(from,to)).filter(c=>!discretionary(c)).join('')};
   }
   let from=before===matched.length?end(last):/\s/u.test(edit.overlay.originalText[change.start]??'')?(before?end(matched[before-1]!):0):begin(matched[before]!);
   const to=change.start===change.end?from:/\s/u.test(edit.overlay.originalText[change.end-1]??'')?(after<matched.length?begin(matched[after]!):replacement.length):after?end(matched[after-1]!):from;
   // An inferred source space absent from the UI address is part of the
   // changed word, rather than an extra separator before its replacement.
   if(change.start!==change.end&&before>0&&before<matched.length&&change.start===originalChars[before]!.start&&originalChars[before-1]!.end===change.start&&/^\s*$/u.test(replacement.slice(end(matched[before-1]!),from)))from=end(matched[before-1]!);
   return{from,to,text:change.replacement};
  });
  for(let i=1;i<matched.length;i++)if(touched.has(i-1)&&touched.has(i)){
   const gap=edit.overlay.originalText.slice(originalChars[i-1]!.end,originalChars[i]!.start),from=end(matched[i-1]!),to=begin(matched[i]!);
   // If both surrounding words change, their unchanged UI separator replaces
   // the source gap too. Otherwise omitted footnotes/logo letters survive.
   if(/^\s+$/u.test(gap)&&!patches.some(p=>p.from<to&&p.to>from))patches.push({from,to,text:gap.replace(/\r\n?|\n/g,' ')});
  }
  for(const p of patches.sort((a,b)=>b.from-a.from))replacement=replacement.slice(0,p.from)+p.text+replacement.slice(p.to);
  const prefix=compactOffset(originalChars,changes[0]?.start??0);
  const firstChange=changes[0],omitted=firstChange&&prefix===compactOffset(originalChars,firstChange.end)&&onlyDiscretionary(edit.overlay.originalText.slice(firstChange.start,firstChange.end));
  const editedAtom=matched[Math.min(matched.length-1,Math.max(0,prefix-(omitted?1:0)))]!.atom;
  return{range,editedAtom,replacement};
 };
 for(const dehyphenate of [false,true]){
  const original=compactMap(edit.overlay.originalText,dehyphenate),chars=compactGlyphs(atoms,group,dehyphenate);
  if(!original.length){if(!dehyphenate)throw Error('empty source selection');continue;}
  // Selected occurrence first; wildcard slots consume exactly one scalar.
  const span=chars.filter(c=>c.atom>=lo&&c.atom<hi);
  if(span.length===original.length&&span.every((c,i)=>matches(c,original[i])))return finish(span,true,original);
  for(let start=0;start+original.length<=chars.length;start++){
   const end=start+original.length,matched=chars.slice(start,end);
   if(hits.some(i=>i>=matched[0]!.atom&&i<=matched.at(-1)!.atom)&&matched.every((c,i)=>matches(c,original[i])))return finish(matched,false,original);
  }
  const optional=optionalSpan(atoms,lo,hi,chars,original,group,selected);
  if(optional)return finish(optional,true,original);
 }
 throw Error('user source text does not match addressed paragraph');
}
