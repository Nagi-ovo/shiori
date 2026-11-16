import type {Rect,RegionProof} from './regionProof';
import {planSuffixGlue} from './reflowJustify';

/** L1 port: only measured PDF advances/ink enter this solver. It cannot find
 * fonts, infer whitespace, grant ownership, or extend a RegionProof. */
export type MeasuredCluster={
 unicode:string;advance:number;ink:Rect;em:number;wordSpace:boolean;gap:number;
 /** Code identity and actual TJ positioning evidence, never Unicode guesses. */
 code?:Uint8Array;tjGap?:true;
 fullEmHan?:boolean;
 original?:{line:number;x:number;y:number};hardAfter?:boolean;lockedAfter?:boolean;
};
export type MeasuredReflowInput={source:readonly MeasuredCluster[];replacement:readonly MeasuredCluster[];
 start:number;end:number;proof:RegionProof;softBreaks:readonly number[];allowSuffix?:boolean;allowWrap?:boolean;
 /** Complete observed row end, including a source trailing TJ displacement. */
 ownEnd?:number};
export type MeasuredReflowResult={ok:true;strategy:'fixed'|'spacing-only'|'row-justify'|'suffix-shift'|'wrap';
 clusters:MeasuredCluster[];origins:[number,number][];reductions:number[];tc:number;tw:number;
 visualLines:string[]}|{ok:false;code:'overflow'|'reflow-required';reason:string};
const fail=(reason:string,code:'overflow'|'reflow-required'='reflow-required'):MeasuredReflowResult=>({ok:false,code,reason});
const han=(s:string)=>/^\p{Script=Han}$/u.test(s);
const cjk=(s:string)=>/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]\p{Mark}*$/u.test(s)||
 /^[、。，．？！：；・「」『』（）［］｛｝〈〉《》【】〔〕〝〟…‥ー々〻ゝゞヽヾ]$/u.test(s);
const latin=(s:string)=>/^[A-Za-z0-9]$/u.test(s);
const close=/^[，。、．；：？！）］｝〉》」』】〕〟’”％‰々〻ゝゞヽヾーぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶㇰ-ㇿ,.!?;:%)\]}]/u;
const open=/[（［｛〈《「『【〔〝‘“([{]$/u;
export const legalMeasuredBreak=(a:MeasuredCluster,b:MeasuredCluster)=>
 !a.lockedAfter&&!open.test(a.unicode)&&!close.test(b.unicode)&&
 (a.unicode===' '||a.unicode==='\u3000'||cjk(a.unicode)&&cjk(b.unicode));
const inside=(ink:Rect,x:number,y:number,box:Rect)=>x+ink.x>=box.x-1e-7&&
 x+ink.x+ink.w<=box.x+box.w+1e-7&&y+ink.y>=box.y-1e-7&&y+ink.y+ink.h<=box.y+box.h+1e-7;

function spacing(tokens:readonly MeasuredCluster[],needed:number){
 const wordCaps:number[]=[],charCaps:number[]=[];
 const total=tokens.reduce((n,t)=>n+t.advance,0);
 for(let i=0;i<tokens.length-1;i++){
  const t=tokens[i]!,next=tokens[i+1]!;
  const clearance=t.advance+next.ink.x-t.ink.x-t.ink.w-.01*t.em;
  const eligible=!t.lockedAfter&&t.advance>0&&next.advance>0&&t.gap>=0&&clearance>0;
  wordCaps[i]=eligible&&t.wordSpace&&t.unicode===' '
   ?Math.max(0,Math.min(.05*t.em,.2*t.advance,t.advance-.2*t.em,clearance)):0;
  charCaps[i]=eligible&&(latin(t.unicode)&&latin(next.unicode)||t.fullEmHan&&next.fullEmHan&&han(t.unicode)&&han(next.unicode))
   ?Math.min((han(t.unicode)?.005:.01)*t.em,clearance):0;
 }
 // One scoped Tc/Tw delta per emitting font: stop at the first per-gap cap.
 const wordGaps=wordCaps.filter(n=>n>0),charGaps=charCaps.filter(n=>n>0);
 let remaining=Math.max(0,Math.min(needed,.02*total));
 const tw=wordGaps.length?Math.min(...wordGaps,remaining/wordGaps.length):0;
 remaining-=tw*wordGaps.length;
 const tc=charGaps.length?Math.min(...charGaps,remaining/charGaps.length):0;
 const reductions=tokens.map((_,i)=>(wordCaps[i]??0)>0?tw:(charCaps[i]??0)>0?tc:0);
 return {tc,tw,reductions,total:reductions.reduce((n,x)=>n+x,0)};
}

export function solveMeasuredReflow(input:MeasuredReflowInput):MeasuredReflowResult {
 const {source,replacement,start,end,proof}=input,slots=proof.lineSlots;
 if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<=start||end>source.length||
  !slots.length||slots.length>8||source.length+replacement.length>4096)return fail('reflow-context-unsupported: invalid range or layout budget');
 if([...source,...replacement].some(t=>!t.unicode||!Number.isFinite(t.advance)||t.advance<0||
  !Number.isFinite(t.em)||t.em<=0||!Number.isFinite(t.gap)||
  ![t.ink.x,t.ink.y,t.ink.w,t.ink.h].every(Number.isFinite)||t.ink.w<0||t.ink.h<0))return fail('glyph-bounds-unavailable: invalid measured cluster');
 if(slots.some((s,i)=>![s.left,s.right,s.baseline].every(Number.isFinite)||s.left>=s.right||i>0&&s.baseline>=slots[i-1]!.baseline))return fail('invalid proven slots');
 if([...source,...replacement].some(t=>/[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff\u200e\u200f\u202a-\u202e\u2066-\u2069\u{10800}-\u{10fff}\u{1e800}-\u{1eeff}]/u.test(t.unicode)))return fail('reflow-break-unsupported: bidi');
 const first=source[start]!.original,last=source[end-1]!.original;
 if(!first||!last||source.some(t=>!t.original))return fail('reflow-context-unsupported: missing source line');
 const crossesLines=first.line!==last.line;
 const row=first.line;if(!slots[row])return fail('invalid source slot');
 const available=last.x+source[end-1]!.advance-first.x;
 const natural=replacement.reduce((n,t)=>n+t.advance,0),needed=natural-available;
 const shrunk=spacing(replacement,needed);
 const tokens=source.map(t=>({...t}));
 for(let i=0;i<tokens.length-1;i++)if(tokens[i]!.original!.line!==tokens[i+1]!.original!.line&&
  !input.softBreaks.includes(tokens[i]!.original!.line))tokens[i]!.hardAfter=true;
 const inserted=replacement.map(t=>({...t,original:undefined}));
 const retainedHardBreak=tokens[end-1]!.hardAfter;
 if(retainedHardBreak&&inserted.length)inserted[inserted.length-1]!.hardAfter=true;
 if(retainedHardBreak&&!inserted.length&&start>0)tokens[start-1]!.hardAfter=true;
 tokens.splice(start,end-start,...inserted);
 const sourceIndices=new Map(source.map((t,i)=>[t.original,i]));
 const retainedGap=(t:MeasuredCluster,next:MeasuredCluster|undefined)=>next?.original&&t.original&&
  t.original.line===next.original.line&&sourceIndices.get(next.original)===sourceIndices.get(t.original)!+1?t.gap:0;
 const baseOrigins=():[number,number][]=>{
  let x=first.x;
  return tokens.map((t,i)=>{
   if(i<start||i>=start+replacement.length)return[t.original!.x,t.original!.y];
   const origin:[number,number]=[x,first.y];x+=t.advance-(shrunk.reductions[i-start]??0);return origin;
  });
 };
 const finish=(strategy:Extract<MeasuredReflowResult,{ok:true}>['strategy'],origins:[number,number][]):MeasuredReflowResult=>{
  if(!proof.occupancyHash&&origins.some((p,i)=>!inside(tokens[i]!.ink,p[0],p[1],proof.box)))return fail('reflow-obstacle: destination ink exceeds proven box','overflow');
  const bands=new Map<number,{bottom:number;top:number;last:number}>();
  for(let i=0;i<tokens.length;i++){
   const t=tokens[i]!,p=origins[i]!;if(!t.ink.w||!t.ink.h)continue;
   const band=bands.get(p[1]);
   if(band){
    const previous=tokens[band.last]!,q=origins[band.last]!;
    const preserved=previous.original&&t.original&&
     Math.abs((p[0]-q[0])-(t.original.x-previous.original.x))<1e-7&&
     Math.abs((p[1]-q[1])-(t.original.y-previous.original.y))<1e-7;
    if(!preserved&&q[0]+previous.ink.x+previous.ink.w>p[0]+t.ink.x+1e-7)
     return fail('reflow-obstacle: new neighbour ink overlaps','overflow');
    band.bottom=Math.min(band.bottom,p[1]+t.ink.y);band.top=Math.max(band.top,p[1]+t.ink.y+t.ink.h);band.last=i;
   }else bands.set(p[1],{bottom:p[1]+t.ink.y,top:p[1]+t.ink.y+t.ink.h,last:i});
  }
  const ordered=[...bands].sort((a,b)=>b[0]-a[0]);
  if(!proof.occupancyHash&&ordered.slice(1).some(([,band],i)=>band.top>ordered[i]![1].bottom+1e-7))
   return fail('reflow-obstacle: destination line ink overlaps','overflow');
  const rows=new Map<number,string>();tokens.forEach((t,i)=>rows.set(origins[i]![1],(rows.get(origins[i]![1])??'')+t.unicode));
  return {ok:true,strategy,clusters:tokens,origins,reductions:shrunk.reductions,tc:shrunk.tc,tw:shrunk.tw,visualLines:[...rows.values()]};
 };
 const hardReplacement=crossesLines||replacement.some(t=>t.hardAfter);
 if(!hardReplacement&&needed<=1e-7)return finish('fixed',baseOrigins());
 if(!hardReplacement&&needed-shrunk.total<=1e-7)return finish('spacing-only',baseOrigins());
 const delta=Math.max(0,needed-shrunk.total),shifted=baseOrigins();
 for(let i=start+replacement.length;i<tokens.length;i++)if(tokens[i]!.original!.line===row)shifted[i]![0]+=delta;
 const fitsRow=(p:readonly number[],t:MeasuredCluster,line:number)=>p[0]!>=slots[line]!.left-1e-7&&
  p[0]!+Math.max(t.advance,t.ink.x+t.ink.w)<=slots[line]!.right+1e-7;
 const ownEnd=input.ownEnd??Math.max(...source.map(t=>t.original!.x+Math.max(t.advance,t.ink.x+t.ink.w)));
 if(!hardReplacement&&slots.length===1&&source.every(t=>t.original!.line===row)&&
  (proof.rowLocal||Math.abs(slots[row]!.right-ownEnd)<=1e-7)){
  const justified=baseOrigins(),suffix=start+replacement.length;
  const previous=tokens[suffix-1],p=justified[suffix-1];
  const glue=planSuffixGlue(tokens.slice(suffix),{...slots[row]!,
   previousInkRight:previous&&p&&previous.ink.w>0&&previous.ink.h>0?p[0]+previous.ink.x+previous.ink.w-delta:undefined},delta);
  if(glue){
   for(let i=suffix;i<tokens.length;i++)justified[i]![0]+=glue.shifts[i-suffix]!;
   if(justified.every((p,i)=>fitsRow(p,tokens[i]!,row)))return finish('row-justify',justified);
  }
 }
 if(!proof.rowLocal&&input.allowSuffix!==false&&!hardReplacement&&shifted.every((p,i)=>fitsRow(p,tokens[i]!,tokens[i]!.original?.line??row)))return finish('suffix-shift',shifted);

 if(proof.rowLocal||input.allowWrap===false)return fail('reflow-spacing-limit: replacement exceeds original slot','overflow');
 const origins=baseOrigins().slice(0,start);
 let cursor=start,line=row,x=first.x;
 while(cursor<tokens.length){
  const slot=slots[line];if(!slot)return fail('reflow-paragraph-full: no additional baseline is authorised','overflow');
  let endpoint=x,endIndex=cursor,lastBreak=-1;
  while(endIndex<tokens.length){
   const t=tokens[endIndex]!,reduction=endIndex>=start&&endIndex<start+replacement.length?shrunk.reductions[endIndex-start]??0:0;
   if(endpoint+t.ink.x<slot.left-1e-7||endpoint+Math.max(t.advance-reduction,t.ink.x+t.ink.w)>slot.right+1e-7)break;
   endpoint+=t.advance-reduction;
   const next=tokens[endIndex+1];
   endpoint+=retainedGap(t,next);
   endIndex++;
   if(t.hardAfter){lastBreak=endIndex;break;}
   if(!next||legalMeasuredBreak(t,next))lastBreak=endIndex;
  }
  if(endIndex<tokens.length&&!tokens[endIndex-1]?.hardAfter)endIndex=lastBreak;
  if(endIndex<=cursor)return fail('reflow-break-unsupported: no legal measured break');
  let destination=x;
  for(let i=cursor;i<endIndex;i++){
   origins.push([destination,slot.baseline]);const t=tokens[i]!;
   destination+=t.advance-(i>=start&&i<start+replacement.length?shrunk.reductions[i-start]??0:0);
   const next=tokens[i+1];
   if(i+1<endIndex)destination+=retainedGap(t,next);
  }
  cursor=endIndex;line++;x=slots[line]?.left??0;
 }
 return finish('wrap',origins);
}
