import type {PDFPage} from 'pdf-lib';
import type {ContentOp} from '../contentStreamEdit/tokenizer';
import {encodeRun} from '../contentStreamEdit/runEncoding';
import {address,type readRetypesetSource} from './retypesetSource';
import type {planRetypeset} from './retypesetPlan';
import {layoutRetypeset,retypesetClusterState} from './retypesetLayout';
import {retypesetScopes} from './retypesetScopes';
import {retypesetInk} from './retypesetInk';
import {planRetypesetPush} from './retypesetPush';
import {reflowScene} from './reflowScene';
import {contains,intersectRect,intersects} from './regionProof/geometry';

type Plan=ReturnType<typeof planRetypeset>;
type Source=ReturnType<typeof readRetypesetSource>;
type Fit=ReturnType<typeof layoutRetypeset>;
type Push=ReturnType<typeof planRetypesetPush>;
type Ink={box:{x:number;y:number;w:number;h:number};known:boolean};
// Any intervening graphics, paint or marked-content transition makes this a
// different scope/style. Repeated text setup is harmless if snapshots agree.
const textOps=new Set(['BT','ET','Tf','Tm','Td','TD','T*','TL','Tc','Tw','Tz','Ts','Tr','Tj','TJ',"'",'"']);
// Match the CJK scripts and punctuation used by reflowLayout's break rules.
const cjk='[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}、。，．？！：；・「」『』（）［］｛｝〈〉《》【】〔〕〝〟…‥ー々〻ゝゞヽヾ]';
const cjkEnd=new RegExp(cjk+'\\p{Mark}*$','u'),cjkStart=new RegExp('^'+cjk,'u');

/** An optional transaction on copies: reclaim only the last changed block's
 * own paragraph tail, at its existing measure, source size and observed pitch.
 * Earlier blocks/prefixes and other paragraphs keep their original ownership.
 * Call after the existing fit ladder so frame/envelope successes stay intact. */
export function tryRetypesetTail(page:PDFPage,ops:ContentOp[],source:Source,plan:Plan,fit:Fit,push:Push,sourceInk:Map<string,Ink>){
 try{
  const block=plan.blocks.at(-1),{group}=plan;
  if(!block||!push.pushed&&!push.overflowInkOverlap||fit.addedHeight<=.01||block.lastLine>=group.lines.length-1||!source.walk.ok||source.walk.unplacedText)return;
  const lastY=Math.min(...block.output.filter(a=>!a.hard).map(a=>a.y!));
  if(!(lastY<group.lines[block.lastLine]!.y-.01))return;
  // A UI selection may combine visual groups. A paragraph gap or an order
  // inversion is never spare height that the tail may reclaim.
  if(!Number.isFinite(group.pitch)||group.pitch<=0||group.lines.slice(block.firstLine+1).some((l,i)=>
   Math.abs(group.lines[block.firstLine+i]!.y-l.y-group.pitch)>.05))return;
  const glyphs=group.lines.slice(block.firstLine).flatMap(l=>l.glyphs),home=glyphs[0]!,state=home.state;
  const font=source.fonts.find(f=>f.resourceName===home.glyph.fontName);
  if(!font||state.renderMode!==0)return;
  const style=['fontSize','charSpacing','wordSpacing','horizontalScale','rise','renderMode'] as const;
  if(glyphs.some(g=>g.glyph.fontName!==font.resourceName||g.text===undefined||Array.from(g.text).some(c=>c.codePointAt(0)!<32||c==='\ufffd')||
   style.some(k=>g.state[k]!==state[k])||g.state.textMatrix!.slice(0,4).some((v,i)=>v!==state.textMatrix![i])||
   g.state.ctm!.some((v,i)=>v!==state.ctm![i])))return;
  const lo=Math.min(...glyphs.map(g=>g.glyph.opIndex)),hi=Math.max(...glyphs.map(g=>g.glyph.opIndex));
  if(ops.slice(lo,hi+1).some(o=>!textOps.has(o.operator)))return;
  const scopes=retypesetScopes(ops);
  if(glyphs.some(g=>!scopes.has(g.glyph.opIndex)||scopes.get(g.glyph.opIndex)!.clip===null))return;
  const lineOf=new Map(group.lines.flatMap((l,i)=>l.glyphs.map(g=>[address(g.glyph),i] as const)));
  const blocks=plan.blocks.map(b=>({...b,output:[...b.output]}));
  blocks.at(-1)!.lastLine=group.lines.length-1;
  blocks.at(-1)!.output=plan.paragraphOutput.filter((a,idx)=>{
   const i=lineOf.get(address(a.home.glyph))!;
   if(i<block.firstLine||a.join&&i===block.firstLine)return false;
   if(!a.join||i<=block.lastLine)return true;
   // Only newly owned tail breaks change joining policy. Keep actual source
   // spaces/codes and the original changed-block plan intact on fallback.
   const previous=plan.paragraphOutput[idx-1]?.text??'',next=group.lines[i]!.glyphs[0]!.text!;
   return !/\s$/u.test(previous)&&!previous.endsWith('-')&&!cjkEnd.test(previous)&&!cjkStart.test(next);
  });
  for(const b of blocks)b.output=b.output.map(a=>{
   const copy={...a,fit:undefined,x:undefined,y:undefined,advance:undefined};
   if(copy.hard)return copy;
   if(copy.home.glyph.fontName!==font.resourceName||copy.font&&copy.font.objectId!==font.objectId)throw Error('not source font');
   if(!copy.bytes){const encoded=encodeRun(copy.text,font,new Uint8Array());if(!encoded.ok)throw Error('unwritable tail');copy.bytes=encoded.bytes;}
   if(copy.bytes.length!==font.bytesPerCode)throw Error('unmeasurable tail cluster');
   copy.font=font;return copy;
  });
  const owned=new Set(blocks.flatMap(b=>Array.from({length:b.lastLine-b.firstLine+1},(_,i)=>b.firstLine+i)));
  const tail=group.lines.filter((_,i)=>owned.has(i)).flatMap(l=>l.glyphs);
  font.assertSource?.(tail.map(g=>g.glyph.byteLength===1?Uint8Array.of(g.glyph.code):Uint8Array.of(g.glyph.code>>8,g.glyph.code&255)));
  const candidate={...plan,blocks,tail,output:blocks.flatMap(b=>b.output),unchangedLines:group.lines.filter((_,i)=>!owned.has(i))};
  const next=layoutRetypeset(candidate,undefined,undefined,{keepTrailingSpaces:true});
  if(!(next.addedHeight<fit.addedHeight-.01))return;
  // addedHeight is block-relative and the retry extends the last block.
  // Compare actual lowest baselines against ONE immutable source baseline.
  const lastSourceY=group.lines.at(-1)!.y;
  const protrusion=(p:Plan)=>Math.max(0,lastSourceY-Math.min(...p.output.filter(a=>!a.hard).map(a=>a.y!)));
  if(protrusion(candidate)>protrusion(plan)+.01)return;
  const measure=retypesetInk(page,source.fonts,ops),ink=new Map(candidate.output.filter(a=>!a.hard).map(a=>{
   const pt=candidate.frame.global(a.x!,a.y!),code=font.bytesPerCode===1?a.bytes![0]!:a.bytes![0]!*256+a.bytes![1]!;
   return[a,measure(font,code,retypesetClusterState(a),pt.x,pt.y)] as const;
  }));
  const media=page.getMediaBox(),crop=page.getCropBox(),pageBox=intersectRect({x:media.x,y:media.y,w:media.width,h:media.height},{x:crop.x,y:crop.y,w:crop.width,h:crop.height});
  if(!pageBox||[...ink].some(([a,o])=>{
   const clip=scopes.get(a.home.glyph.opIndex)!.clip;
   return !o.known||!contains(pageBox,o.box)||clip&&!contains(clip,o.box);
  }))return;
  const entries=[...ink];
  const blockOf=new Map(blocks.flatMap((b,i)=>b.output.map(a=>[a,i] as const)));
  if(entries.some(([a,o],i)=>entries.slice(i+1).some(([b,p])=>
   (blockOf.get(a)!==blockOf.get(b)||Math.abs(a.y!-b.y!)>.01)&&intersects(o.box,p.box))))return;
  // An unpushed retry must fully absorb growth. A still-needed original or
  // chain push retains its original delta and moved set via fallback.
  if(next.addedHeight>.01)return;
  const target=new Set(tail.map(g=>address(g.glyph)));
  const obstacles=source.glyphs.filter(g=>!target.has(address(g.glyph))).map(g=>sourceInk.get(address(g.glyph))!)
   .filter(o=>o.known).map(o=>o.box);
  reflowScene(page,ops,pageBox,(box,kind)=>{if(kind!=='backdrop'&&kind!=='unknown')obstacles.push(box);},.01);
  if(entries.some(([,o])=>o.box.w>0&&o.box.h>0&&obstacles.some(b=>b.w>0&&b.h>0&&intersects(o.box,b))))return;
  const retry=planRetypesetPush(page,ops,source,candidate,next,target,[...ink.values()],sourceInk);
  // Never introduce a new push; dropping an old push also requires clear ink.
  if(retry.pushed||push.pushed&&retry.overflowInkOverlap)return;
  return{plan:candidate,fit:next,ink,push:retry};
 }catch{ /* The original changed-line plan remains the fallback. */ }
}
