import type {ContentTextOverlay} from '../../model/types';
import type {ContentOp} from '../contentStreamEdit/tokenizer';
import {quadIntersectsRect,removalsByRect} from '../contentStreamEdit/removeGlyphs';
import {address,paragraphGroups} from './retypesetSource';
import {lineChanges} from './diff';
import type {RetypesetCluster,RetypesetEdit,RetypesetGlyph,RetypesetGroup} from './retypesetTypes';
const normalize=(s:string)=>s.replace(/\s+/gu,' ').trim();
export function selectRetypeset(glyphs:RetypesetGlyph[],overlay:ContentTextOverlay){
 const hits=new Set(removalsByRect(glyphs.map(g=>g.glyph),overlay.coverRects).flatMap(s=>[...s]));
 return glyphs.filter(g=>hits.has(g.glyph)||(!hits.size&&overlay.coverRects.some(r=>quadIntersectsRect(g.glyph.quad,r))));
}
function sourceAtoms(group:RetypesetGroup){
 const atoms:RetypesetCluster[]=[];
 for(const [i,line]of group.lines.entries()){
  if(i&&atoms.length&&!/\s$/u.test(atoms.at(-1)!.text)&&!/^\s/u.test(line.glyphs[0]!.text??'')&&
   !/\p{Script=Han}$/u.test(atoms.at(-1)!.text))atoms.push({text:' ',home:line.glyphs[0]!});
  for(const [j,g]of line.glyphs.entries()){
   const previous=line.glyphs[j-1];
   if(previous){
    const end=previous.x+previous.glyph.tjCompensation*previous.state.fontSize/1000*(previous.state.horizontalScale??1);
    if(g.x-end>g.state.fontSize*.2&&!/\s$/u.test(previous.text??'')&&!/^\s/u.test(g.text??''))atoms.push({text:' ',home:g});
   }
   const bytes=g.glyph.byteLength===1?Uint8Array.of(g.glyph.code):Uint8Array.of(g.glyph.code>>8,g.glyph.code&255);
   atoms.push({text:g.text??'\ufffd',bytes,home:g});
  }
 }
 return atoms;
}
/** Match Unicode near the addressed glyphs. Geometry locates; only immutable
 * glyph identities authorize deletion. Unknown Unicode uses the user's span. */
function selectedRange(atoms:RetypesetCluster[],edit:RetypesetEdit):{range:[number,number];replacement:string;editedAtom:number}{
 const selected=new Set(edit.selected.map(g=>address(g.glyph))),hits=atoms.flatMap((a,i)=>a.bytes&&selected.has(address(a.home.glyph))?[i]:[]);
 if(!hits.length)throw Error('selection has no paragraph glyphs');
 const chars:{char:string;atom:number;offset:number}[]=[];
 atoms.forEach((a,i)=>{let offset=0;for(const char of a.text){if(/\s/u.test(char)){if(chars.at(-1)?.char!==' ')chars.push({char:' ',atom:i,offset});}else chars.push({char,atom:i,offset});offset+=char.length;}});
 const hay=chars.map(c=>c.char).join(''),needle=normalize(edit.overlay.originalText);
 if(!needle)throw Error('empty source selection');
 let at=hay.indexOf(needle);
 while(at>=0){
  // offsets below use UTF-16, as String.indexOf does.
  const start=Array.from(hay.slice(0,at)).length,end=start+Array.from(needle).length;
  const first=chars[start]!.atom,last=chars[end-1]!.atom;
  if(hits.some(i=>i>=first&&i<=last)){
   const changes=lineChanges(edit.overlay.originalText,edit.overlay.text);
   const soft=(s:string)=>s.replace(/\r\n?|\n/g,' ');
   let cursor=0,replacement='';
   for(const change of changes){replacement+=soft(edit.overlay.originalText.slice(cursor,change.start))+change.replacement;cursor=change.end;}
   replacement+=soft(edit.overlay.originalText.slice(cursor));
   const prefix=edit.overlay.originalText.slice(0,changes[0]?.start??0).replace(/\s+/gu,' ').trimStart();
   const editedAtom=chars[Math.min(end-1,start+Array.from(prefix).length)]!.atom;
   return{range:[first,last+1],editedAtom,replacement:atoms[first]!.text.slice(0,chars[start]!.offset)+replacement+atoms[last]!.text.slice(chars[end-1]!.offset+chars[end-1]!.char.length)};
  }
  at=hay.indexOf(needle,at+1);
 }
 if(atoms.slice(hits[0],hits.at(-1)!+1).some(a=>a.home.text===undefined))return{range:[hits[0]!,hits.at(-1)!+1],editedAtom:hits[0]!,replacement:edit.overlay.text};
 throw Error('user source text does not match addressed paragraph');
}
function replacementAtoms(old:RetypesetCluster[],replacement:string){
 const source=old.map(a=>a.text).join(''),changes=lineChanges(source,replacement.replace(/\r\n?/g,'\n').normalize('NFC'));
 const atoms=[...old];
 for(const change of changes.toReversed()){
  let offset=0,start=-1,end=-1;
  for(let i=0;i<=atoms.length;i++){
   if(offset===change.start)start=i;if(offset===change.end)end=i;
   if(i<atoms.length)offset+=atoms[i]!.text.length;
  }
  let insert=change.replacement;
  if(start<0||end<0){
   let pos=0;
   for(let i=0;i<atoms.length;i++){
    const next=pos+atoms[i]!.text.length;
    if(start<0&&change.start>pos&&change.start<next){start=i;insert=atoms[i]!.text.slice(0,change.start-pos)+insert;}
    if(end<0&&change.end>pos&&change.end<next){end=i+1;insert+=atoms[i]!.text.slice(change.end-pos);}
    pos=next;
   }
  }
  if(start<0||end<0)throw Error('invalid Unicode selection');
  const home=atoms[start]?.home??atoms.at(-1)!.home;
  atoms.splice(start,end-start,...Array.from(insert,c=>({text:c,home,hard:c==='\n'})));
 }
 return atoms;
}
export function planRetypeset(glyphs:RetypesetGlyph[],ops:ContentOp[],edits:RetypesetEdit[]){
 const frame=paragraphGroups(glyphs,ops,edits[0]!.selected[0]!),group=frame.group;
 if(!group)throw Error('no paragraph at selection');
 const atoms=sourceAtoms(group),ranges=edits.map(e=>({e,...selectedRange(atoms,e)})).sort((a,b)=>a.range[0]-b.range[0]);
 if(ranges.some((r,i)=>i>0&&r.range[0]<ranges[i-1]!.range[1]))throw Error('overlapping edits in one paragraph');
 const first=Math.min(...ranges.map(r=>r.editedAtom)),firstGlyph=atoms[first]!.home;
 const firstLine=group.lines.findIndex(l=>l.glyphs.some(g=>address(g.glyph)===address(firstGlyph.glyph)));
 const tail=group.lines.slice(firstLine).flatMap(l=>l.glyphs),target=new Set(tail.map(g=>address(g.glyph)));
 const start=atoms.findIndex(a=>a.bytes&&target.has(address(a.home.glyph)));
 let output=[...atoms];
 for(const {replacement,range:[lo,hi]}of ranges.toReversed())output.splice(lo,hi-lo,...replacementAtoms(output.slice(lo,hi),replacement));
 output=output.slice(start);
 return {frame,group,tail,output,firstLine};
}
