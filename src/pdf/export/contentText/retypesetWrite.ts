import {PDFPage} from 'pdf-lib';
import {PDFDict,PDFName,PDFObjectCopier,PDFRawStream} from 'pdf-lib';
import type {ContentOp} from '../contentStreamEdit/tokenizer';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {removeIdentifiedGlyphs} from '../contentStreamEdit/removeGlyphs';
import {walkTextPlacements} from '../contentStreamEdit/textState';
import {pdfNumber,codes} from '../contentStreamEdit/runEncoding';
import {type FallbackOptions} from '../contentStreamEdit/fallbackFont';
import {substitutionStamp} from '../contentStreamEdit/substituteSnapshot';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import type {readRetypesetSource} from './retypesetSource';
import {address} from './retypesetSource';
import type {planRetypeset} from './retypesetPlan';
import type {RetypesetCluster,RetypesetManifest} from './retypesetTypes';
import {verifyRetypesetGlyphs} from './retypesetVerify';
import {chooseRetypesetFontFit,prepareRetypesetFontFit,retypesetFitIdentity} from './retypesetFontFit';
import {retypesetFontSelector} from './retypesetFontSelection';
import {withCachedLocalFonts} from '../fonts/fontService';
import {retypesetClusterState} from './retypesetLayout';
import {markedShow,retainedMarkedGlyphs,stripNamedEquivalents} from './retypesetMarkedShows';
import {emitRetypesetText} from './retypesetTextEmit';
import {observeRetypesetPainted,retypesetPaintedClears,retypesetPaintedLive,retypesetPaintedShadow,retypesetPaintedSourceInk} from './retypesetPainted';
import {planRetypesetPush,verifyRetypesetPushPaint,type RetypesetChainRules} from './retypesetPush';
import {retypesetFormPushSpace} from './retypesetForms';
import {retypesetScopes} from './retypesetScopes';
import {intersects} from './regionProof/geometry';
import {prepareRetypesetFits} from './retypesetFit';
import {retypesetInk} from './retypesetInk';
import {layoutRetypesetInClip} from './retypesetClip';
import {fitRetypesetEnvelope,retypesetFlowEnvelope,type RetypesetEnvelope} from './retypesetEnvelope';
import {planRetypesetChain,retypesetChainEligible,retypesetChainRescue,retypesetChainRules,retypesetChainShadow} from './retypesetChain';
import {tryRetypesetTail} from './retypesetTail';
import {verifyWrappedArtwork} from './wrappedArtwork';

export const RETYPESET_SIZE_UNMET='size-request-unmet';
type Plan=ReturnType<typeof planRetypeset>;
type Source=ReturnType<typeof readRetypesetSource>;
type WrittenRetypeset=Omit<RetypesetManifest,'reason'>&{strippedEquivalentIds?:string[]};
/** Compile in scratch resources, rewalk, verify every untargeted glyph, then
 * install. Each home show emits under its original graphics/marked scope. */
export async function writeRetypeset(...args:Parameters<typeof prepareRetypesetWrite>):Promise<WrittenRetypeset[]>{
 const prepared=await prepareRetypesetWrite(...args);
 prepared.install();
 return prepared.manifests;
}

export async function prepareRetypesetWrite(page:PDFPage,bytes:Uint8Array,ops:ContentOp[],source:Source,plans:Plan[],options:FallbackOptions,pushBlockReason?:string,allowTailReflow=true,protectArtwork=false){
 const formSpace=retypesetFormPushSpace(page),contents=page.doc.context.lookup(page.node.get(PDFName.of('Contents')));
 if(contents instanceof PDFRawStream&&contents.dict.get(PDFName.of('Subtype'))===PDFName.of('Form')&&!formSpace)throw Error('push-blocked-by-form-context: Form stream is not a detached CoW occurrence');
 const stamp=substitutionStamp(page);
 const originalResources=page.node.Resources(),originalContents=page.node.get(PDFName.of('Contents'));
 const fontDict=originalResources?.lookupMaybe(PDFName.of('Font'),PDFDict);
 const fontOptions=withCachedLocalFonts(options),select=retypesetFontSelector(fontOptions);
 const {selected,proved}=await chooseRetypesetFontFit(
  generic=>prepareRetypesetFontFit(page,ops,source,plans,fontOptions,select,generic),
  candidate=>compileRetypeset(page,bytes,ops,source,candidate,pushBlockReason,allowTailReflow,protectArtwork),
 );
 const current=inspectRunPage(page);if(!current.ok||current.bytes.length!==bytes.length||current.bytes.some((v,i)=>v!==bytes[i])||page.node.Resources()!==originalResources||page.node.get(PDFName.of('Contents'))!==originalContents||substitutionStamp(page)!==stamp)throw Error('page changed during retypeset preparation');
 return {manifests:proved.manifests,install(){
  for(const observe of proved.observations)observe();
  const copier=PDFObjectCopier.for(selected.scratch.context,page.doc.context),patchedFonts=fontDict?.clone()??page.doc.context.obj({});
  for(const p of selected.prepared)patchedFonts.set(PDFName.of(p.resolved.resourceName),copier.copy(p.ref));
  proved.resources.set(PDFName.of('Font'),patchedFonts);
  const stream=page.doc.context.register(page.doc.context.flateStream(proved.compiled));
  page.node.set(PDFName.of('Resources'),proved.resources);page.node.set(PDFName.of('Contents'),stream);
 }};
}

type Candidate=Awaited<ReturnType<typeof prepareRetypesetFontFit>>;
type CompiledRetypeset={compiled:Uint8Array;resources:PDFDict;manifests:WrittenRetypeset[];identity:()=>string;observations:(()=>void)[]};
function compileRetypeset(page:PDFPage,bytes:Uint8Array,ops:ContentOp[],source:Source,candidate:Candidate,
 pushBlockReason:string|undefined,allowTailReflow:boolean,protectArtwork:boolean):CompiledRetypeset{
 const {scratch,fonts,names,prepared}=candidate,plans=[...candidate.plans];
 const formSpace=retypesetFormPushSpace(page),originalResources=page.node.Resources();
 const fontDict=originalResources?.lookupMaybe(PDFName.of('Font'),PDFDict);
 const observations:(()=>void)[]=[];
 const chainObserver=retypesetChainShadow.observe,paintedObserver=retypesetPaintedShadow.observe;
 const observeChain=(existing:ReturnType<typeof planRetypesetPush>,chain:ReturnType<typeof planRetypesetPush>)=>{
  if(chainObserver)observations.push(()=>chainObserver(existing,chain));
 };
 const hits=plans.flatMap(p=>p.tail.map(g=>g.glyph)),target=new Set(hits.map(address));
 if(target.size!==hits.length)throw Error('intersecting paragraph ownership');
 // Measurement-only resources may reference private scratch font dictionaries;
 // nothing is installed until compilation and the moved/untouched proofs pass.
 const measureNode=page.node.clone(),measureResources=originalResources?.clone()??page.doc.context.obj({}),measureFonts=fontDict?.clone()??page.doc.context.obj({});
 for(const p of prepared)measureFonts.set(PDFName.of(p.resolved.resourceName),scratch.context.lookup(p.ref)!);
 measureResources.set(PDFName.of('Font'),measureFonts);measureNode.set(PDFName.of('Resources'),measureResources);
 const measurePage=PDFPage.of(measureNode,page.ref,page.doc);
 const {sourceInk,results:fitted}=prepareRetypesetFits(page,measurePage,ops,fonts,source,plans,target);
 const fits=fitted.map(f=>f.fit);
 const ink=retypesetInk(measurePage,fonts,ops);
 const scopes=retypesetScopes(ops,formSpace?.box);
 const measureOf=(p:Plan)=>(a:RetypesetCluster)=>{
  const pt=p.frame.global(a.x!,a.y!),code=codes(a.bytes!,a.font!.bytesPerCode)[0]!;
  return ink(a.font!,code,retypesetClusterState(a),pt.x,pt.y);
 };
 const outputInks=plans.map((p,i)=>{
  const laid=layoutRetypesetInClip(p,fits[i]!,scopes,measureOf(p));
  fits[i]=laid.fit;return laid.ink;
 });
 const planPush=(i:number,chain?:RetypesetChainRules,stored=sourceInk)=>{
  const p=plans[i]!,ink=outputInks[i]!,internalOverlap=p.blocks.some((b,j)=>p.blocks.slice(j+1).some(next=>
   b.output.some(a=>ink.has(a)&&next.output.some(c=>ink.has(c)&&intersects(ink.get(a)!.box,ink.get(c)!.box)))));
  const fixed=outputInks.flatMap((m,j)=>j===i?[]:[...m.values()]);
  return planRetypesetPush(page,ops,source,p,fits[i]!,target,[...ink.values()],stored,
   pushBlockReason??(plans.length>1?'multiple-edited-paragraphs':undefined),fixed,internalOverlap,formSpace,fitted[i]!.frame,chain);
 };
 const pushes=plans.map((_,i)=>planPush(i));
 // Additive in-column fit ladder. It runs only for a single edited paragraph
 // that is still overlapping after the push and frame paths; pushes, frame
 // tightens and clear rows never reach it and keep their exact output.
 // A one-line own-band envelope claims no witnessed space, so it is tried
 // last: only after the chain push below also leaves the row overlapping.
 const ownBand=plans.map(()=>undefined as RetypesetEnvelope|undefined),envelopeRestore:(()=>void)[]=[];
 const fitEnvelope=(i:number,envelope:RetypesetEnvelope,stored=sourceInk)=>{
  const p=plans[i]!,ladder=fitRetypesetEnvelope(p,envelope,scopes,measureOf(p));
  if(!ladder)return undefined;
  const retry=planRetypesetPush(page,ops,source,p,ladder.fit,target,[...ladder.ink.values()],stored,pushBlockReason);
  if(retry.pushed||retry.overflowInkOverlap){ladder.restore();return undefined;}
  fits[i]=ladder.fit;outputInks[i]=ladder.ink;pushes[i]=retry;envelopeRestore[i]=ladder.restore;return ladder.envelopeFit;
 };
 const envelopeFits=plans.map((p,i)=>{
  const push=pushes[i]!;
  if(plans.length>1||formSpace||fitted[i]!.frame||push.pushed||!push.overflowInkOverlap||pushBlockReason==='multiple-stream-edits')return undefined;
  const envelope=retypesetFlowEnvelope(page,ops,source,p,target,sourceInk,[...outputInks[i]!.values()]);
  if(envelope?.ownBand){ownBand[i]=envelope;return undefined;}
  return envelope&&fitEnvelope(i,envelope);
 });
 // Same-column chain push, only for a single paragraph every earlier path
 // left overlapping. All followers move by one proved delta or none do; a
 // chain whose compiled proof fails falls back to the existing outcome.
 const rules=retypesetChainRules(measurePage,fonts),chained=plans.map(()=>undefined as typeof pushes[number]|undefined);
 plans.forEach((_,i)=>{
  const push=pushes[i]!;
  if(push.pushed&&chainObserver)observeChain(push,planRetypesetChain(r=>planPush(i,r),rules));
  if(plans.length>1||formSpace||fitted[i]!.frame||envelopeFits[i]||pushBlockReason||!retypesetChainEligible(push))return;
  const chain=planRetypesetChain(r=>planPush(i,r),rules,retypesetChainRescue);observeChain(push,chain);if(chain.pushed){chained[i]=push;pushes[i]=chain;}
 });
 ownBand.forEach((envelope,i)=>{if(envelope&&!chained[i]&&!pushes[i]!.pushed&&pushes[i]!.overflowInkOverlap)envelopeFits[i]=fitEnvelope(i,envelope);});
 // Reclaim source-size tail slack before painted coverage may shrink a row.
 // Painted coverage can then clear a false overlap on the reclaimed layout.
 const originalPlan=plans[0];
 const tail=allowTailReflow&&plans.length===1&&!formSpace&&!pushBlockReason&&!fitted[0]!.frame&&!envelopeFits[0]&&
  (pushes[0]!.pushed||pushes[0]!.overflowInkOverlap)&&
  tryRetypesetTail(measurePage,ops,source,plans[0]!,fits[0]!,pushes[0]!,sourceInk);
 if(tail){
  plans[0]=tail.plan;hits.splice(0,hits.length,...tail.plan.tail.map(g=>g.glyph));
  target.clear();for(const g of hits)target.add(address(g));
  fits[0]=tail.fit;outputInks[0]=tail.ink;pushes[0]=tail.push;chained[0]=undefined;
 }
 // Painted coverage for unknown stationary ink (r32 P2-B). The shadow
 // re-plans every row on it and reports; live use (retypesetPainted.ts)
 // touches only rows still overlapping, never a push, chain, frame or fit.
 const painted=retypesetPaintedSourceInk(source,target,sourceInk,rules.painted),undo:(()=>void)[]=[];
 if(paintedObserver){
  observeRetypesetPainted(pushes.map((push,i)=>({push:chained[i]?pushes[i]!:push,strategy:chained[i]?'chain-push':envelopeFits[i]?'fit-envelope':fitted[i]!.frameFit?'tighten-frame':push.pushed?'push':'none'})),painted.changed,
   i=>chained[i]?planRetypesetChain(r=>planPush(i,r,painted.ink),rules,retypesetChainRescue):planPush(i,undefined,painted.ink),
   observation=>observations.push(()=>paintedObserver(observation)));
 }
 if(retypesetPaintedLive.enabled&&painted.changed)plans.forEach((p,i)=>{
  const push=pushes[i]!,fit=fits[i]!,ink=outputInks[i]!;
  if(chained[i]||envelopeFits[i]||fitted[i]!.frame||push.pushed||!push.overflowInkOverlap)return;
  // First push: a false whole-page flag clears without moving anything.
  const replan=planPush(i,undefined,painted.ink);
  if(retypesetPaintedClears(replan,ink.values())){pushes[i]=replan;undo.push(()=>{pushes[i]=push;});return;}
  // Envelope pass, under the same conditions as the stored-ink one.
  if(plans.length>1||formSpace||pushBlockReason==='multiple-stream-edits')return;
  const envelope=retypesetFlowEnvelope(page,ops,source,p,target,painted.ink,[...ink.values()]);
  if(envelope&&(envelopeFits[i]=fitEnvelope(i,envelope,painted.ink)))undo.push(()=>{envelopeRestore[i]!();fits[i]=fit;outputInks[i]=ink;pushes[i]=push;envelopeFits[i]=undefined;});
 });
 // Sanitized property dictionaries are private copies, preserving OC/MCID.
 const resources=originalResources?.clone()??page.doc.context.obj({}),properties=resources.lookupMaybe(PDFName.of('Properties'),PDFDict)?.clone();
 const marked=markedShow(ops,properties),skip=(a:RetypesetCluster)=>!!a.inferred&&marked(a.home.glyph);
 const pinned=retainedMarkedGlyphs(hits,source,marked,new Map(pushes.flatMap(p=>[...p.glyphDeltas])));
 const removed=removeIdentifiedGlyphs(bytes,ops,[...hits,...pinned.map(a=>a.home.glyph)],stripNamedEquivalents(properties),pdfNumber);
 if(!removed.changed)throw Error('no addressed glyphs removed');
 // Removal preserves op count (Tj becomes TJ), except quote operators. Map
 // rewritten source slots by their ordered show-op identity, not byte offsets.
 const removedOps=tokenizeContentStream(removed.bytes),shows=(os:ContentOp[])=>os.flatMap((o,i)=>['Tj','TJ',"'",'"'].includes(o.operator)?[i]:[]);
 const oldShows=shows(ops),newShows=shows(removedOps);if(oldShows.length!==newShows.length)throw Error('show identity changed during removal');
 // Removal only expands addressed quote shows. Map every original operator
 // boundary so graphics spans retain their source identity through that pass.
 const mapped=new Map<number,{start:number;end:number}>();let index=0;
 const removedShows=new Set([...hits,...pinned.map(a=>a.home.glyph)].map(g=>g.opIndex));
 for(const [i,op]of ops.entries()){
  const extra=removedShows.has(i)?op.operator==='"'?3:op.operator==="'"?1:0:0;
  mapped.set(op.start,{start:removedOps[index]!.start,end:removedOps[index+extra]!.end});index+=1+extra;
 }
 const compile=()=>{
 const deltas=new Map(pushes.flatMap(p=>[...p.glyphDeltas])),patches=emitRetypesetText(plans,source,fonts,removedOps,oldShows,newShows,skip,pinned);
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
 const destinations=plans.flatMap(p=>p.output.filter(a=>!a.hard&&!skip(a)).map(a=>{
  const encoded=codes(a.bytes!,a.font!.bytesPerCode);if(encoded.length!==1)throw Error('unmeasurable shaped output');
  return{fontName:a.font!.resourceName,code:encoded[0]!,point:p.frame.global(a.x!,a.y!)};
 }));
 verifyRetypesetGlyphs(after.glyphs,untargeted,destinations);
 return{compiled,after};
 };
 let built:ReturnType<typeof compile>;
 try{built=compile();}catch(error){
  if(tail)return compileRetypeset(page,bytes,ops,source,{...candidate,plans:[originalPlan!]},pushBlockReason,false,protectArtwork);
  // A chain push or painted adoption whose compiled proof fails falls back
  // to the existing outcome (the two never share a page: a chain needs a
  // single edited paragraph, which painted use never revisits after it).
  if(!chained.some(Boolean)&&!undo.length)throw error;
  chained.forEach((push,i)=>{if(push)pushes[i]=push;});chained.fill(undefined);undo.splice(0).forEach(u=>u());built=compile();
 }
 const {compiled,after}=built;
 if(protectArtwork)verifyWrappedArtwork(page,ops,plans,fits[0]!.lines,pushes[0]!.pushed,prepared.length,
  outputInks[0]!.values(),sourceInk,target,hits);
 // A user size request is part of the result: no fit may have rescaled it.
 for(const p of plans)for(const a of p.output)if(!a.hard&&a.size&&a.size!==1&&Math.abs(retypesetClusterState(a).fontSize-a.home.state.fontSize*a.size)>1e-6)
  throw Error(`${RETYPESET_SIZE_UNMET}: requested ${a.size}x source size, fit would emit ${retypesetClusterState(a).fontSize/a.home.state.fontSize}x`);
 if(properties)resources.set(PDFName.of('Properties'),properties);
 const manifests=plans.map((p,i)=>{
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
  const frameFit=fitted[i]!.frameFit;
  const strippedEquivalentIds=[...p.coveredMarks].filter(([,marks])=>removed.strippedEquivalentOps.some(op=>marks.has(op))).map(([id])=>id);
  return {paragraphBox:{x,y,w:right-x,h:top-y},substituteFont:names[i]??null,lineCount:fits[i]!.lines,overflowed:frameFit?!frameFit.fits:fits[i]!.addedHeight>.01||fits[i]!.maxRight>p.group.right+.01,pushed:push.pushed,pushedDeltaPt:push.pushedDeltaPt,pushedRegions:push.regions,
   ...(frameFit?{fitStrategy:'tighten-frame' as const,frameFit}:{}),...(envelopeFits[i]?{fitStrategy:'fit-envelope' as const,envelopeFit:envelopeFits[i]}:{}),...(chained[i]?{fitStrategy:'chain-push' as const}:{}),
   pushReason:push.pushReason,overflowInkOverlap:push.overflowInkOverlap,
   unchangedLineDriftPt:Math.max(0,...push.glyphDeltas.values(),residualX,residualY),
   ...(strippedEquivalentIds.length?{strippedEquivalentIds}:{}),
   quality:{maxUnchangedLineStartXDriftPt:residualX,maxUnchangedLineBaselineDriftPt:residualY,overflowInkOverlap:push.overflowInkOverlap}};
 });
 return {compiled,resources,manifests,identity:()=>retypesetFitIdentity(plans,manifests,pushes),observations};
}
