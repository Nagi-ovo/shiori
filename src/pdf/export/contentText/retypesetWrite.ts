import {PDFPage} from 'pdf-lib';
import {PDFDict,PDFName,PDFObjectCopier,PDFDocument,PDFRawStream} from 'pdf-lib';
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
import type {RetypesetCluster,RetypesetManifest} from './retypesetTypes';
import {restoreReflowSlot} from './reflowEmit';
import {prepareRetypesetFallback} from './retypesetFallback';
import {verifyRetypesetGlyphs} from './retypesetVerify';
import {originalFallbackFace,retypesetFontSelector} from './retypesetFontSelection';
import {layoutRetypeset} from './retypesetLayout';
import {planRetypesetPush,verifyRetypesetPushPaint} from './retypesetPush';
import {numericArray} from './reflowScene';
import {retypesetScopes} from './retypesetScopes';
import {intersects} from './regionProof/geometry';
import {retypesetInk} from './retypesetInk';
import {layoutRetypesetInClip} from './retypesetClip';

type Plan=ReturnType<typeof planRetypeset>;
type Source=ReturnType<typeof readRetypesetSource>;
function restore(s:ShowTextState,fonts:ResolvedRunFont[]){
 return restoreReflowSlot({bt:0,opIndex:s.opIndex,ctm:s.ctm!,tm:s.textMatrix!,tlm:s.lineMatrix!,fontObject:fonts.find(f=>f.resourceName===s.fontName)!.objectId,size:s.fontSize,tc:s.charSpacing,tw:s.wordSpacing,tz:s.horizontalScale!*100,leading:s.leading!,rise:s.rise!,renderMode:s.renderMode!,safetyHash:'approximate'},fonts);
}
/** Compile in scratch resources, rewalk, verify every untargeted glyph, then
 * install. Each home show emits under its original graphics/marked scope. */
export async function writeRetypeset(page:PDFPage,bytes:Uint8Array,ops:ContentOp[],source:Source,plans:Plan[],options:FallbackOptions,pushBlockReason?:string):Promise<Omit<RetypesetManifest,'reason'>[]>{
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
 const fits=plans.map(p=>layoutRetypeset(p)),hits=plans.flatMap(p=>p.tail.map(g=>g.glyph)),target=new Set(hits.map(address));
 if(target.size!==hits.length)throw Error('intersecting paragraph ownership');
 // Measurement-only resources may reference private scratch font dictionaries;
 // nothing is installed until compilation and the moved/untouched proofs pass.
 const measureNode=page.node.clone(),measureResources=originalResources?.clone()??page.doc.context.obj({}),measureFonts=fontDict?.clone()??page.doc.context.obj({});
 for(const p of prepared)measureFonts.set(PDFName.of(p.resolved.resourceName),scratch.context.lookup(p.ref)!);
 measureResources.set(PDFName.of('Font'),measureFonts);measureNode.set(PDFName.of('Resources'),measureResources);
 const ink=retypesetInk(PDFPage.of(measureNode,page.ref,page.doc),fonts,ops);
 const sourceInk=new Map(source.glyphs.map(g=>[address(g.glyph),ink(fonts.find(f=>f.resourceName===g.glyph.fontName)!,g.glyph.code,g.state,g.x,g.y)]));
 const formBox=originalContents instanceof PDFRawStream?numericArray(originalContents.dict,'BBox'):undefined;
 const initialClip=formBox?.length===4?{x:formBox[0]!,y:formBox[1]!,w:formBox[2]!-formBox[0]!,h:formBox[3]!-formBox[1]!}:undefined;
 const scopes=retypesetScopes(ops,initialClip);
 const outputInks=plans.map((p,i)=>{
  const laid=layoutRetypesetInClip(p,fits[i]!,scopes,a=>{
   const pt=p.frame.global(a.x!,a.y!),code=codes(a.bytes!,a.font!.bytesPerCode)[0]!;
   return ink(a.font!,code,a.home.state,pt.x,pt.y);
  });
  fits[i]=laid.fit;return laid.ink;
 });
 const pushes=plans.map((p,i)=>{
  const ink=outputInks[i]!,internalOverlap=p.blocks.some((b,j)=>p.blocks.slice(j+1).some(next=>
   b.output.some(a=>ink.has(a)&&next.output.some(c=>ink.has(c)&&intersects(ink.get(a)!.box,ink.get(c)!.box)))));
  const fixed=outputInks.flatMap((m,j)=>j===i?[]:[...m.values()]);
  return planRetypesetPush(page,ops,source,p,fits[i]!,target,[...ink.values()],sourceInk,
   pushBlockReason??(plans.length>1?'multiple-edited-paragraphs':undefined),fixed,internalOverlap);
 });
 const deltas=new Map(pushes.flatMap(p=>[...p.glyphDeltas]));

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
 // Removal only expands addressed quote shows. Map every original operator
 // boundary so graphics spans retain their source identity through that pass.
 const mapped=new Map<number,{start:number;end:number}>();let index=0;
 const removedShows=new Set(hits.map(g=>g.opIndex));
 for(const [i,op]of ops.entries()){
  const extra=removedShows.has(i)?op.operator==='"'?3:op.operator==="'"?1:0:0;
  mapped.set(op.start,{start:removedOps[index]!.start,end:removedOps[index+extra]!.end});index+=1+extra;
 }
 for(const push of pushes)for(const patch of push.patches){
  const first=mapped.get(patch.start)!,last=ops.find(o=>o.end===patch.end)!;
  patches.push({start:first.start,body:patch.prefix},{start:mapped.get(last.start)!.end,body:patch.suffix});
 }
 const chunks:Uint8Array[]=[];let cursor=0;
 for(const patch of patches.sort((a,b)=>a.start-b.start)){chunks.push(removed.bytes.subarray(cursor,patch.start),new TextEncoder().encode(patch.body));cursor=patch.start;}
 chunks.push(removed.bytes.subarray(cursor));const compiled=new Uint8Array(chunks.reduce((n,c)=>n+c.length,0));let offset=0;for(const c of chunks){compiled.set(c,offset);offset+=c.length;}
 const compiledOps=tokenizeContentStream(compiled);
 verifyRetypesetPushPaint(page,ops,compiledOps,new Map(pushes.flatMap(p=>[...p.paintDeltas])));
 const after=walkTextPlacements(compiledOps,{...source.callbacks,resolveFont:name=>{const f=fonts.find(f=>f.resourceName===name);return f?(source.fonts.includes(f)?source.callbacks.resolveFont(name):{...f,ok:true,appliesWordSpacing:f.bytesPerCode===1}):{ok:false,reason:'unmeasurable font'};}});
 if(!after.ok)throw Error(`compiled text walk failed: ${after.reason}`);
 const shift=(points:readonly {x:number;y:number}[],delta:number)=>points.map(p=>({x:p.x,y:p.y-delta}));
 const untargeted=source.glyphs.filter(g=>!target.has(address(g.glyph))).map(g=>{
  const delta=deltas.get(address(g.glyph))??0,quad=shift(g.glyph.quad,delta),core=shift(g.glyph.coreQuad,delta);
  return{...g.glyph,quad,coreQuad:core};
 });
 const destinations=plans.flatMap(p=>p.output.filter(a=>!a.hard).map(a=>{
  const encoded=codes(a.bytes!,a.font!.bytesPerCode);if(encoded.length!==1)throw Error('unmeasurable shaped output');
  return{fontName:a.font!.resourceName,code:encoded[0]!,point:p.frame.global(a.x!,a.y!)};
 }));
 verifyRetypesetGlyphs(after.glyphs,untargeted,destinations);
 const current=inspectRunPage(page);if(!current.ok||current.bytes.length!==bytes.length||current.bytes.some((v,i)=>v!==bytes[i])||page.node.Resources()!==originalResources||page.node.get(PDFName.of('Contents'))!==originalContents||substitutionStamp(page)!==stamp)throw Error('page changed during retypeset preparation');
 const patchedFonts=fontDict?.clone()??page.doc.context.obj({}),copier=PDFObjectCopier.for(scratch.context,page.doc.context);
 for(const p of prepared)patchedFonts.set(PDFName.of(p.resolved.resourceName),copier.copy(p.ref));
 resources.set(PDFName.of('Font'),patchedFonts);if(properties)resources.set(PDFName.of('Properties'),properties);
 const stream=page.doc.context.register(page.doc.context.flateStream(compiled));
 page.node.set(PDFName.of('Resources'),resources);page.node.set(PDFName.of('Contents'),stream);
 return plans.map((p,i)=>{
  const points=p.group.lines.flatMap(l=>l.glyphs.flatMap(g=>g.glyph.quad)),x=Math.min(...points.map(p=>p.x)),y=Math.min(...points.map(p=>p.y)),right=Math.max(...points.map(p=>p.x)),top=Math.max(...points.map(p=>p.y));
  const push=pushes[i]!,keys=new Set(p.group.lines.flatMap(l=>l.glyphs.map(g=>address(g.glyph))));
  let residualX=0,residualY=0;
  for(const g of source.glyphs){
   if(target.has(address(g.glyph))||!keys.has(address(g.glyph)))continue;
   const delta=push.glyphDeltas.get(address(g.glyph))??0;
   const match=after.glyphs.find(a=>a.fontName===g.glyph.fontName&&a.code===g.glyph.code&&Math.abs(a.coreQuad[0].x-g.x)<=.05&&Math.abs(a.coreQuad[0].y-(g.y-delta))<=.05);
   if(!match)continue;
   residualX=Math.max(residualX,Math.abs(match.coreQuad[0].x-g.x));
   residualY=Math.max(residualY,Math.abs(match.coreQuad[0].y-(g.y-delta)));
  }
  return {paragraphBox:{x,y,w:right-x,h:top-y},substituteFont:names[i]??null,lineCount:fits[i]!.lines,overflowed:fits[i]!.addedHeight>.01||fits[i]!.maxRight>p.group.right+.01,pushed:push.pushed,pushedDeltaPt:push.pushedDeltaPt,pushedRegions:push.regions,
   pushReason:push.pushReason,overflowInkOverlap:push.overflowInkOverlap,
   unchangedLineDriftPt:Math.max(0,...push.glyphDeltas.values(),residualX,residualY),
   quality:{maxUnchangedLineStartXDriftPt:residualX,maxUnchangedLineBaselineDriftPt:residualY,overflowInkOverlap:push.overflowInkOverlap}};
 });
}
