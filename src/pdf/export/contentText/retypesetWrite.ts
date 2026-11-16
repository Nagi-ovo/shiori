import type {PDFPage} from 'pdf-lib';
import {PDFDict,PDFName,PDFObjectCopier,PDFDocument} from 'pdf-lib';
import type {ContentOp} from '../contentStreamEdit/tokenizer';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {removeIdentifiedGlyphs} from '../contentStreamEdit/removeGlyphs';
import {walkTextPlacements,type ShowTextState} from '../contentStreamEdit/textState';
import {hex,pdfName,pdfNumber,encodeRun,codes} from '../contentStreamEdit/runEncoding';
import {type FallbackOptions} from '../contentStreamEdit/fallbackFont';
import {substitutionStamp} from '../contentStreamEdit/substituteSnapshot';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import type {ResolvedRunFont} from '../contentStreamEdit/replaceRun';
import type {readRetypesetSource} from './retypesetSource';
import {address} from './retypesetSource';
import type {planRetypeset} from './retypesetPlan';
import type {RetypesetCluster} from './retypesetTypes';
import {restoreReflowSlot} from './reflowEmit';
import {prepareRetypesetFallback} from './retypesetFallback';
import {verifyRetypesetGlyphs} from './retypesetVerify';
import {originalFallbackFace,retypesetFontSelector} from './retypesetFontSelection';

type Plan=ReturnType<typeof planRetypeset>;
type Source=ReturnType<typeof readRetypesetSource>;
function restore(s:ShowTextState,fonts:ResolvedRunFont[]){
 return restoreReflowSlot({bt:0,opIndex:s.opIndex,ctm:s.ctm!,tm:s.textMatrix!,tlm:s.lineMatrix!,fontObject:fonts.find(f=>f.resourceName===s.fontName)!.objectId,size:s.fontSize,tc:s.charSpacing,tw:s.wordSpacing,tz:s.horizontalScale!*100,leading:s.leading!,rise:s.rise!,renderMode:s.renderMode!,safetyHash:'approximate'},fonts);
}
function layout(plan:Plan){
 const {group,firstLine,output}=plan,size=plan.tail[0]!.state.fontSize;
 let x=group.lines[firstLine]!.x,y=group.lines[firstLine]!.y,lines=1,maxRight=x;
 const left=group.lines[1]?.x??group.left,right=Math.max(group.right,left+size),width=right-left;
 const advance=(a:RetypesetCluster)=>{
  const f=a.font!,s=a.home.state,code=f.bytesPerCode===1?a.bytes![0]!:a.bytes![0]!*256+a.bytes![1]!;
  return (f.widthOf(code)*s.fontSize/1000+s.charSpacing+(f.bytesPerCode===1&&code===32?s.wordSpacing:0))*(s.horizontalScale??1);
 };
 for(const a of output)if(!a.hard){a.advance=advance(a);if(!Number.isFinite(a.advance)||a.advance<0)throw Error('unmeasurable output advance');}
 const newline=()=>{x=left;y-=group.pitch;lines++;};
 for(let i=0;i<output.length;){
  if(output[i]!.hard){newline();i++;continue;}
  let end=i+1;
  if(!/\s|\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(output[i]!.text))while(end<output.length&&!output[end]!.hard&&!/\s|\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(output[end]!.text))end++;
  const needed=output.slice(i,end).reduce((n,a)=>n+a.advance!,0);
  if(x>left+.01&&x+needed>right+.01&&needed<=width)newline();
  for(;i<end;i++){
   const a=output[i]!;
   // A trailing space may hang past the measure; it must not start the next
   // row and indent its first word. Only ink-bearing clusters force a wrap.
   if(x>left+.01&&x+a.advance!>right+.01&&!/^\s+$/u.test(a.text))newline();
   a.x=x;a.y=y;x+=a.advance!;maxRight=Math.max(maxRight,x);
  }
 }
 return {lines,bottom:y-size*.25,top:group.lines[firstLine]!.y+size,maxRight};
}
/** Compile in scratch resources, rewalk, verify every untargeted glyph, then
 * install. Each home show emits under its original graphics/marked scope. */
export async function writeRetypeset(page:PDFPage,bytes:Uint8Array,ops:ContentOp[],source:Source,plans:Plan[],options:FallbackOptions){
 const scratch=await PDFDocument.create(),fonts=[...source.fonts],prepared:Awaited<ReturnType<typeof prepareRetypesetFallback>>[]=[],names:(string|null)[]=[];
 const stamp=substitutionStamp(page);
 const originalResources=page.node.Resources(),originalContents=page.node.get(PDFName.of('Contents'));
 const fontDict=originalResources?.lookupMaybe(PDFName.of('Font'),PDFDict);
 const used=new Set(fonts.map(f=>f.resourceName));
 const selectFont=retypesetFontSelector(options);
 for(const plan of plans){
  const missing:RetypesetCluster[]=[];
  for(const a of plan.output){
   if(a.hard)continue;
   const font=fonts.find(f=>f.resourceName===a.home.glyph.fontName)!;
   if(a.bytes){a.font=font;continue;}
   try{const encoded=encodeRun(a.text,font,new Uint8Array());if(encoded.ok){a.bytes=encoded.bytes;a.font=font;continue;}}catch{ /* approximate substitute below */ }
   missing.push(a);
  }
  // Include the unchanged prefix as well as the complete output tail: a
  // Latin-only hole must not select Liberation for a CJK paragraph.
  const prefix=plan.group.lines.slice(0,plan.firstLine).flatMap(l=>l.glyphs.map(g=>g.text??'')).join('');
  const paragraph=prefix+plan.output.map(a=>a.text).join(''),byFace=new Map<string,RetypesetCluster[]>(),selectedNames=new Set<string>();
  for(const a of missing){const name=originalFallbackFace(page,a.home.glyph.fontName,paragraph),group=byFace.get(name)??[];group.push(a);byFace.set(name,group);}
  for(const [primary,atoms]of byFace)for(const {name,data,clusters}of await selectFont(primary,paragraph,atoms.map(a=>a.text))){
   let i=1;while(used.has(`ShioriRt${i}`))i++;const resource=`ShioriRt${i}`;used.add(resource);
   // These are exactly the clusters shown in this substitute. Preparation
   // verifies their coverage and outlines before any page resources change.
   const p=await prepareRetypesetFallback(scratch,resource,name,clusters,{loadFont:async()=>data});prepared.push(p);fonts.push(p.resolved);selectedNames.add(name);
   for(const a of atoms.filter(a=>clusters.includes(a.text.normalize('NFC')))){const encoded=encodeRun(a.text,p.resolved,new Uint8Array());if(!encoded.ok)throw Error('substitute cannot encode replacement');a.bytes=encoded.bytes;a.font=p.resolved;}
  }
  names.push(selectedNames.size?[...selectedNames].join(', '):null);
 }
 const fits=plans.map(layout),hits=plans.flatMap(p=>p.tail.map(g=>g.glyph)),target=new Set(hits.map(address));
 if(target.size!==hits.length)throw Error('intersecting paragraph ownership');
 // Sanitized property dictionaries are private copies, preserving OC/MCID.
 const resources=originalResources?.clone()??page.doc.context.obj({}),properties=resources.lookupMaybe(PDFName.of('Properties'),PDFDict)?.clone();
 const renamed=new Map<string,string>();
 const removed=removeIdentifiedGlyphs(bytes,ops,hits,name=>{
  if(renamed.has(name))return renamed.get(name)!;
  const dict=properties?.lookupMaybe(PDFName.of(name),PDFDict);if(!dict||!['ActualText','Alt','E'].some(k=>dict.has(PDFName.of(k))))return null;
  let i=1;while(properties!.has(PDFName.of(`ShioriRtProp${i}`)))i++;
  const replacement=`ShioriRtProp${i}`,copy=dict.clone();for(const k of ['ActualText','Alt','E'])copy.delete(PDFName.of(k));
  properties!.set(PDFName.of(replacement),copy);renamed.set(name,replacement);return replacement;
 },pdfNumber);
 if(!removed.changed)throw Error('no addressed glyphs removed');
 // Removal preserves op count (Tj becomes TJ), except quote operators. Map
 // rewritten source slots by their ordered show-op identity, not byte offsets.
 const removedOps=tokenizeContentStream(removed.bytes),shows=(os:ContentOp[])=>os.flatMap((o,i)=>['Tj','TJ',"'",'"'].includes(o.operator)?[i]:[]);
 const oldShows=shows(ops),newShows=shows(removedOps);if(oldShows.length!==newShows.length)throw Error('show identity changed during removal');
 const byOp=new Map<number,RetypesetCluster[]>();
 for(const plan of plans)for(const a of plan.output)if(!a.hard){const id=a.home.glyph.opIndex;const list=byOp.get(id)??[];list.push(a);byOp.set(id,list);}
 const patches:{start:number;body:string}[]=[];
 for(const [opIndex,atoms]of byOp){
  const before={...source.glyphs.find(g=>g.glyph.opIndex===opIndex)!.state,...source.ends.get(opIndex)!},body:string[]=[' q'];
  for(let cursor=0;cursor<atoms.length;){
   const a=atoms[cursor]!;
   const p=plans.find(p=>p.output.includes(a))!,global=p.frame.global(a.x!,a.y!),s=a.home.state,ct=s.ctm!,tm=s.textMatrix!,det=ct[0]!*ct[3]!-ct[1]!*ct[2]!;
   const x=(ct[3]!*(global.x-ct[4]!)-ct[2]!*(global.y-ct[5]!))/det-s.rise!*tm[2]!;
   const y=(-ct[1]!*(global.x-ct[4]!)+ct[0]!*(global.y-ct[5]!))/det-s.rise!*tm[3]!;
   const along=(dx:number)=>{
    const q=p.frame.global(dx,0),tx=(ct[3]!*q.x-ct[2]!*q.y)/det,ty=(-ct[1]!*q.x+ct[0]!*q.y)/det;
    const length=tm[0]!**2+tm[1]!**2,advance=(tx*tm[0]!+ty*tm[1]!)/length;
    return{advance,across:Math.hypot(tx-advance*tm[0]!,ty-advance*tm[1]!)};
   };
   // Keep adjacent characters in one real show string. Per-character Tm/Tj
   // fragments can make PDFium extract a newline after every character.
   let end=cursor+1;
   for(;end<atoms.length;end++){
    const next=atoms[end]!,previous=atoms[end-1]!,ns=next.home.state;
    if(next.font!==a.font||Math.abs(next.y!-a.y!)>1e-8||Math.abs(next.x!-previous.x!-previous.advance!)>1e-7||along(next.x!-previous.x!).across>1e-8||
     (['fontSize','charSpacing','wordSpacing','horizontalScale','rise','renderMode']as const).some(k=>ns[k]!==s[k])||
     ns.textMatrix!.slice(0,4).some((v,i)=>v!==tm[i])||ns.ctm!.some((v,i)=>v!==ct[i]))break;
   }
   const items:string[]=[];let adjusted=false;
   for(let i=cursor;i<end;i++){
    const current=atoms[i]!;items.push(hex(current.bytes!));
    if(i+1===end)continue;
    const code=codes(current.bytes!,current.font!.bytesPerCode)[0]!;
    const natural=current.font!.widthOf(code)*s.fontSize/1000+s.charSpacing+(current.font!.bytesPerCode===1&&code===32?s.wordSpacing:0);
    // Different source lines can have different text-matrix scales. TJ
    // reaches the planned destination in this home slot's own text space.
    const adjustment=(natural-along(atoms[i+1]!.x!-current.x!).advance/s.horizontalScale!)*1000/s.fontSize;
    if(Math.abs(adjustment)>1e-10){items.push(pdfNumber(adjustment));adjusted=true;}
   }
   const show=adjusted?`[${items.join(' ')}] TJ`:`${hex(Uint8Array.from(atoms.slice(cursor,end).flatMap(t=>[...t.bytes!])))} Tj`;
   body.push(`${[...tm.slice(0,4),x,y].map(pdfNumber).join(' ')} Tm ${pdfName(a.font!.resourceName)} ${pdfNumber(s.fontSize)} Tf ${pdfNumber(s.charSpacing)} Tc ${pdfNumber(s.wordSpacing)} Tw ${pdfNumber(s.horizontalScale!*100)} Tz ${pdfNumber(s.rise!)} Ts ${s.renderMode} Tr ${show}`);
   cursor=end;
  }
  body.push('Q',restore(before,fonts));
  // Quote operators move the line before showing. Insert after an explicit
  // equivalent prefix; source snapshots are already after that line move.
  const rewritten=removedOps[newShows[oldShows.indexOf(opIndex)]!]!;
  patches.push({start:rewritten.end,body:body.join(' ')+' '});
 }
 const chunks:Uint8Array[]=[];let cursor=0;
 for(const patch of patches.sort((a,b)=>a.start-b.start)){chunks.push(removed.bytes.subarray(cursor,patch.start),new TextEncoder().encode(patch.body));cursor=patch.start;}
 chunks.push(removed.bytes.subarray(cursor));const compiled=new Uint8Array(chunks.reduce((n,c)=>n+c.length,0));let offset=0;for(const c of chunks){compiled.set(c,offset);offset+=c.length;}
 const after=walkTextPlacements(tokenizeContentStream(compiled),{...source.callbacks,resolveFont:name=>{const f=fonts.find(f=>f.resourceName===name);return f?{...f,ok:true,appliesWordSpacing:f.bytesPerCode===1}:{ok:false,reason:'unmeasurable font'};}});
 if(!after.ok)throw Error(`compiled text walk failed: ${after.reason}`);
 const destinations=plans.flatMap(p=>p.output.filter(a=>!a.hard).map(a=>{
  const encoded=codes(a.bytes!,a.font!.bytesPerCode);if(encoded.length!==1)throw Error('unmeasurable shaped output');
  return{fontName:a.font!.resourceName,code:encoded[0]!,point:p.frame.global(a.x!,a.y!)};
 }));
 verifyRetypesetGlyphs(after.glyphs,source.glyphs.filter(g=>!target.has(address(g.glyph))).map(g=>g.glyph),destinations);
 const current=inspectRunPage(page);if(!current.ok||current.bytes.length!==bytes.length||current.bytes.some((v,i)=>v!==bytes[i])||page.node.Resources()!==originalResources||page.node.get(PDFName.of('Contents'))!==originalContents||substitutionStamp(page)!==stamp)throw Error('page changed during retypeset preparation');
 const patchedFonts=fontDict?.clone()??page.doc.context.obj({}),copier=PDFObjectCopier.for(scratch.context,page.doc.context);
 for(const p of prepared)patchedFonts.set(PDFName.of(p.resolved.resourceName),copier.copy(p.ref));
 resources.set(PDFName.of('Font'),patchedFonts);if(properties)resources.set(PDFName.of('Properties'),properties);
 const stream=page.doc.context.register(page.doc.context.flateStream(compiled));
 page.node.set(PDFName.of('Resources'),resources);page.node.set(PDFName.of('Contents'),stream);
 return plans.map((p,i)=>{
  const points=p.group.lines.flatMap(l=>l.glyphs.flatMap(g=>g.glyph.quad)),x=Math.min(...points.map(p=>p.x)),y=Math.min(...points.map(p=>p.y)),right=Math.max(...points.map(p=>p.x)),top=Math.max(...points.map(p=>p.y));
  return {paragraphBox:{x,y,w:right-x,h:top-y},substituteFont:names[i]??null,lineCount:fits[i]!.lines+p.firstLine,overflowed:fits[i]!.bottom<p.group.lines.at(-1)!.y-p.tail[0]!.state.fontSize*.25-.01||fits[i]!.maxRight>p.group.right+.01,pushed:false as const};
 });
}
