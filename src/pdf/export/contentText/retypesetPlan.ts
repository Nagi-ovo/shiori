import type {ContentTextOverlay} from '../../model/types';
import type {ContentOp} from '../contentStreamEdit/tokenizer';
import {quadIntersectsRect,removalsByRect} from '../contentStreamEdit/removeGlyphs';
import {address,paragraphGroups,retypesetAdvance} from './retypesetSource';
import {lineChanges} from './diff';
import {selectedRange} from './retypesetAddress';
import type {RetypesetCluster,RetypesetEdit,RetypesetGlyph,RetypesetGroup} from './retypesetTypes';
export function selectRetypeset(glyphs:RetypesetGlyph[],overlay:ContentTextOverlay){
 const hits=new Set(removalsByRect(glyphs.map(g=>g.glyph),overlay.coverRects).flatMap(s=>[...s]));
 return glyphs.filter(g=>hits.has(g.glyph)||(!hits.size&&overlay.coverRects.some(r=>quadIntersectsRect(g.glyph.quad,r))));
}
function sourceAtoms(group:RetypesetGroup,local:(x:number,y:number)=>{x:number;y:number}){
 const atoms:RetypesetCluster[]=[];
 for(const [i,line]of group.lines.entries()){
  if(i&&atoms.length&&!/\s$/u.test(atoms.at(-1)!.text)&&!/^\s/u.test(line.glyphs[0]!.text??'')&&
   !/\p{Script=Han}$/u.test(atoms.at(-1)!.text))atoms.push({text:' ',home:line.glyphs[0]!,join:true,inferred:true});
  for(const [j,g]of line.glyphs.entries()){
   const previous=line.glyphs[j-1];
   if(previous){
    const end=previous.x+retypesetAdvance(previous,local);
    if(g.x-end>g.state.fontSize*.2&&!/\s$/u.test(previous.text??'')&&!/^\s/u.test(g.text??''))atoms.push({text:' ',home:g,inferred:true});
   }
   const bytes=g.glyph.byteLength===1?Uint8Array.of(g.glyph.code):Uint8Array.of(g.glyph.code>>8,g.glyph.code&255);
   atoms.push({text:g.text??'\ufffd',bytes,home:g});
  }
 }
 return atoms;
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
  // An insert at a synthetic inter-line join belongs to the preceding line,
  // not to the next line's first glyph (the join's home).
  const homeAtom=start>0&&(start===end||atoms[start]?.join)?[...atoms.slice(0,start)].toReversed().find(a=>!a.join)??atoms[start-1]!:atoms[start]??atoms.at(-1)!;
  const home=homeAtom!.home;
  atoms.splice(start,end-start,...Array.from(insert,c=>({text:c,home,hard:c==='\n'})));
 }
 return atoms;
}
/** The toolbar size relative to the captured source size, in the same UI
 * space, so actual text/CTM/Form matrices stay and only Tf scales. */
export function retypesetSizeRequest(overlay:ContentTextOverlay){
 const source=overlay.sourceStyle?.fontSize;
 return source&&source>0&&Number.isFinite(overlay.fontSize)&&overlay.fontSize>0&&Math.abs(overlay.fontSize-source)>1e-6?overlay.fontSize/source:1;
}
export function planRetypeset(glyphs:RetypesetGlyph[],ops:ContentOp[],edits:RetypesetEdit[]){
 if(!edits.length||edits.some(e=>!e.selected.length))throw Error('empty glyph selection');
 const frame=paragraphGroups(glyphs,ops,edits[0]!.selected[0]!,edits.flatMap(e=>e.selected)),group=frame.group;
 if(!group)throw Error('no paragraph at selection');
 const atoms=sourceAtoms(group,frame.local),ranges=edits.map(e=>({e,...selectedRange(atoms,e,group)})).sort((a,b)=>a.range[0]-b.range[0]);
 if(ranges.some((r,i)=>i>0&&r.range[0]<ranges[i-1]!.range[1]))throw Error('overlapping edits in one paragraph');
 let output=[...atoms];
 const lineOf=new Map(group.lines.flatMap((l,i)=>l.glyphs.map(g=>[address(g.glyph),i] as const)));
 const line=(a:RetypesetCluster)=>lineOf.get(address(a.home.glyph))!;
 const changed=new Set<number>(),coveredMarks=new Map<string,Set<number>>();
 // A size request re-emits every addressed cluster, including unchanged
 // text: copies are never original atoms, so their lines become owned.
 for(const {e,replacement,range:[lo,hi]}of ranges.toReversed()){
  const old=output.slice(lo,hi),size=retypesetSizeRequest(e.overlay);
  const replacementAtomsForRange=replacementAtoms(old,replacement);
  const next=size===1?replacementAtomsForRange:replacementAtomsForRange.map(a=>({...a,size}));
  output.splice(lo,hi-lo,...next);
  const before=new Set(old),after=new Set(next),changedHere=new Set<number>();
  for(const a of old)if(a.bytes&&!after.has(a))changedHere.add(line(a));
  for(const a of next)if(!before.has(a))changedHere.add(line(a));
  for(const i of changedHere)changed.add(i);
  // A batch rewrites the union of changed lines. Keep each edit's addressed
  // marks on its own changed lines so siblings do not inherit evidence.
  const marks=new Set(old.flatMap(a=>a.bytes&&changedHere.has(line(a))?a.home.glyph.markedContent:[]));
  if(marks.size)coveredMarks.set(e.overlay.id,marks);
 }
 if(!changed.size){
  // Compact-only hyphen/soft-hyphen folds can request a change that is
  // already absent from the engine glyphs. Keep every original show.
  if(output.length!==atoms.length||output.some((a,i)=>a!==atoms[i]&&a.text!==atoms[i]!.text))throw Error('no changed source line');
  return {frame,group,tail:[],output:[],paragraphOutput:[],firstLine:0,blocks:[],unchangedLines:group.lines,coveredMarks};
 }
 const blocks:{firstLine:number;lastLine:number;output:RetypesetCluster[]}[]=[];
 for(const i of [...changed].sort((a,b)=>a-b)){
  const previous=blocks.at(-1);
  if(previous&&previous.lastLine===i-1)previous.lastLine=i;
  else blocks.push({firstLine:i,lastLine:i,output:[]});
 }
 for(const block of blocks)block.output=output.filter(a=>{
  const i=line(a);
  return i>=block.firstLine&&i<=block.lastLine&&(!a.join||i>block.firstLine);
 });
 const firstLine=blocks[0]!.firstLine,tail=group.lines.filter((_,i)=>changed.has(i)).flatMap(l=>l.glyphs);
 const paragraphOutput=output;
 output=blocks.flatMap(b=>b.output);
 return {frame,group,tail,output,paragraphOutput,firstLine,blocks,unchangedLines:group.lines.filter((_,i)=>!changed.has(i)),coveredMarks};
}
