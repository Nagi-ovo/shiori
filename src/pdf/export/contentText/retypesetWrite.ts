import type {PDFPage} from 'pdf-lib';
import {PDFDict,PDFName,PDFObjectCopier,PDFDocument} from 'pdf-lib';
import type {ContentOp} from '../contentStreamEdit/tokenizer';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {removeIdentifiedGlyphs} from '../contentStreamEdit/removeGlyphs';
import {walkTextPlacements,type ShowTextState} from '../contentStreamEdit/textState';
import {hex,pdfName,pdfNumber,encodeRun,codes} from '../contentStreamEdit/runEncoding';
import {fallbackFontName,type FallbackOptions} from '../contentStreamEdit/fallbackFont';
import {substitutionStamp} from '../contentStreamEdit/substituteSnapshot';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import type {ResolvedRunFont} from '../contentStreamEdit/replaceRun';
import type {readRetypesetSource} from './retypesetSource';
import {address} from './retypesetSource';
import type {planRetypeset} from './retypesetPlan';
import type {RetypesetCluster} from './retypesetTypes';
import {restoreReflowSlot} from './reflowEmit';
import {prepareRetypesetFallback} from './retypesetFallback';

type Plan=ReturnType<typeof planRetypeset>;
type Source=ReturnType<typeof readRetypesetSource>;
function restore(s:ShowTextState,fonts:ResolvedRunFont[]){
 return restoreReflowSlot({bt:0,opIndex:s.opIndex,ctm:s.ctm!,tm:s.textMatrix!,tlm:s.lineMatrix!,fontObject:fonts.find(f=>f.resourceName===s.fontName)!.objectId,size:s.fontSize,tc:s.charSpacing,tw:s.wordSpacing,tz:s.horizontalScale!*100,leading:s.leading!,rise:s.rise!,renderMode:s.renderMode!,safetyHash:'approximate'},fonts);
}
function baseFace(page:PDFPage,name:string){
 const f=page.node.Resources()?.lookupMaybe(PDFName.of('Font'),PDFDict)?.lookupMaybe(PDFName.of(name),PDFDict);
 return f?.lookupMaybe(PDFName.of('BaseFont'),PDFName)?.decodeText()??name;
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
  const name=fallbackFontName(baseFace(page,plan.tail[0]!.glyph.fontName),0,prefix+plan.output.map(a=>a.text).join(''));
  names.push(missing.length?name:null);
  if(missing.length){
   let i=1;while(used.has(`ShioriRt${i}`))i++;const resource=`ShioriRt${i}`;used.add(resource);
   // These are exactly the clusters shown in this substitute. Preparation
   // verifies their coverage and outlines before any page resources change.
   const p=await prepareRetypesetFallback(scratch,resource,name,missing.map(a=>a.text),options);prepared.push(p);fonts.push(p.resolved);
   for(const a of missing){const encoded=encodeRun(a.text,p.resolved,new Uint8Array());if(!encoded.ok)throw Error('substitute cannot encode replacement');a.bytes=encoded.bytes;a.font=p.resolved;}
  }
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
   // Keep adjacent characters in one real show string. Per-character Tm/Tj
   // fragments can make PDFium extract a newline after every character.
   let end=cursor+1;
   for(;end<atoms.length;end++){
    const next=atoms[end]!,previous=atoms[end-1]!,ns=next.home.state;
    if(next.font!==a.font||Math.abs(next.y!-a.y!)>1e-8||Math.abs(next.x!-previous.x!-previous.advance!)>1e-7||
     (['fontSize','charSpacing','wordSpacing','horizontalScale','rise','renderMode']as const).some(k=>ns[k]!==s[k])||
     ns.textMatrix!.slice(0,4).some((v,i)=>v!==tm[i])||ns.ctm!.some((v,i)=>v!==ct[i]))break;
   }
   const data=Uint8Array.from(atoms.slice(cursor,end).flatMap(t=>[...t.bytes!]));
   body.push(`${[...tm.slice(0,4),x,y].map(pdfNumber).join(' ')} Tm ${pdfName(a.font!.resourceName)} ${pdfNumber(s.fontSize)} Tf ${pdfNumber(s.charSpacing)} Tc ${pdfNumber(s.wordSpacing)} Tw ${pdfNumber(s.horizontalScale!*100)} Tz ${pdfNumber(s.rise!)} Ts ${s.renderMode} Tr ${hex(data)} Tj`);
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
 const signature=(g:typeof hits[number])=>JSON.stringify([g.fontName,g.code,g.quad.map(p=>[Math.round(p.x*1e5),Math.round(p.y*1e5)])]);
 const actual=new Map<string,number>();for(const g of after.glyphs){const k=signature(g);actual.set(k,(actual.get(k)??0)+1);}
 for(const g of source.glyphs)if(!target.has(address(g.glyph))){const k=signature(g.glyph),count=actual.get(k)??0;if(!count)throw Error('untargeted glyph changed font, codes or position');actual.set(k,count-1);}
 const positions=new Map<string,number>();
 const position=(font:string,code:number,x:number,y:number)=>JSON.stringify([font,code,Math.round(x*1e5),Math.round(y*1e5)]);
 for(const g of after.glyphs){const k=position(g.fontName,g.code,g.coreQuad[0].x,g.coreQuad[0].y);positions.set(k,(positions.get(k)??0)+1);}
 const consume=(key:string)=>{const count=positions.get(key)??0;if(!count)throw Error('output glyph font, codes or destination differs');positions.set(key,count-1);};
 for(const g of source.glyphs)if(!target.has(address(g.glyph)))consume(position(g.glyph.fontName,g.glyph.code,g.glyph.coreQuad[0].x,g.glyph.coreQuad[0].y));
 for(const p of plans)for(const a of p.output)if(!a.hard){const encoded=codes(a.bytes!,a.font!.bytesPerCode);if(encoded.length!==1)throw Error('unmeasurable shaped output');const point=p.frame.global(a.x!,a.y!);consume(position(a.font!.resourceName,encoded[0]!,point.x,point.y));}
 const expectedCount=source.glyphs.length-hits.length+plans.reduce((n,p)=>n+p.output.filter(a=>!a.hard).reduce((n,a)=>n+a.bytes!.length/a.font!.bytesPerCode,0),0);
 if(after.glyphs.length!==expectedCount)throw Error('compiled glyph count differs');
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
