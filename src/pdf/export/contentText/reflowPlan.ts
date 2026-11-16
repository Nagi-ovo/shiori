import type {ContentTextOverlay} from '../../model/types';
import type {PageRunPlan} from '../contentStreamEdit/pageRunPlan';
import {replaceRuns,sourceFingerprint,type ResolvedRunFont} from '../contentStreamEdit/replaceRun';
import {codes,encodeRun,same} from '../contentStreamEdit/runEncoding';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {walkTextPlacements} from '../contentStreamEdit/textState';
import {removalsByRect} from '../contentStreamEdit/removeGlyphs';
import {RunCompileError} from '../contentStreamEdit/runRefusal';
import {detectParagraphRegion,type SourceAddress,type TextTrace} from './regionProof';
import {origin,matrixEqual,near,contains,intersects,validRect,physicalSize,linear} from './regionProof/geometry';
import {solveMeasuredReflow} from './reflowLayout';
import {traceReflowSource,ReflowTraceError} from './reflowTrace';
import type {ContentTextPlan} from './planner';
import type {ContentTextEnvironment,ReflowCodeCluster} from './reflowTypes';
export type {ReflowRequest,ReflowOptions} from './reflowTypes';
export {reflowDefaults} from './reflowTypes';
export const reflowAddressKey=(s:SourceAddress)=>`${s.opIndex}:${s.itemIndex}:${s.byteStart}:${s.byteEnd}:${s.fontObject}`;
const fail=(reason:string):ContentTextPlan=>({ok:false,code:'reflow-required',reason});
const traceEqual=(a:TextTrace,b:TextTrace)=>matrixEqual(a.tm,b.tm)&&matrixEqual(a.tlm,b.tlm)&&
 (a.scopeKey??'')===(b.scopeKey??'')&&JSON.stringify(a.mcids??[])===JSON.stringify(b.mcids??[])&&a.scopeSafe!==false&&b.scopeSafe!==false&&
 matrixEqual(a.ctm,b.ctm)&&a.bt===b.bt&&a.fontObject===b.fontObject&&
 (['size','tc','tw','tz','leading','rise','renderMode'] as const).every(k=>near(a[k],b[k],1e-8));

/** Explicit request path only: the ordinary overlay carries no authority to
 * soften source breaks or discover empty scene/ink. After proof validation,
 * fixed-neighbour edits are tried before the measured overflow tactics.
 */
export function planReflow(content:Uint8Array,fonts:readonly ResolvedRunFont[],overlay:ContentTextOverlay,environment:ContentTextEnvironment):ContentTextPlan {
 const request=environment.reflowRequest;
 if(!environment.stage5Reflow||!request)return fail('reflow-paragraph-unproven: no explicit reflow request');
 const {paragraph,target}=request,sourceHash=sourceFingerprint(content),replacementText=overlay.text.replace(/\r\n?/g,'\n');
 // Only the stream producer can defer membership/scene checks and then run
 // proveGlyphRegion on the solved origins. Explicit requests keep their
 // original rectangle contract and cannot opt into half of that protocol.
 if(paragraph.occupancy)return fail('reflow-context-unsupported: deferred occupancy requires stream evidence');
 if(paragraph.sourceHash!==sourceHash||request.dependencyHash!==paragraph.dependencyHash||target.streamHash!==sourceHash)
  return fail('reflow-paragraph-unproven: stale source/dependency revision');
 const ops=tokenizeContentStream(content);
 if(JSON.stringify(ops)!==JSON.stringify(paragraph.ops))return fail('reflow-paragraph-unproven: operator evidence differs from current source');
 const detected=detectParagraphRegion(paragraph);
 if(!detected.ok)return fail(`${detected.code}: ${detected.blocker}: ${detected.detail}`);
 // Reserve horizontal raster coverage before any layout, just as the stream
 // producer does. Slots keep their original left/right capacity. A substitute
 // landing at a body left must not paint an antialias pixel outside the proof.
 const region=detected.proof,box={...region.box,x:region.box.x-.5,w:region.box.w+1};
 const scene=paragraph.evidence;
 if(!contains(scene.crop,box)||!contains(scene.clip,box)||scene.obstacles.some(o=>
  !o.box||intersects(box,o.box)&&(o.kind!=='stationary-backdrop'||!contains(o.box,box))))return fail('reflow-obstacle: raster guard is not proved clear');
 const proof={...region,box};
 if(proof.lineSlots.length>8||request.softBreaks.some(i=>!Number.isInteger(i)||i<0||i>=proof.lineSlots.length-1))return fail('reflow-context-unsupported: line/break budget');
 try{
  const traces=traceReflowSource(ops,fonts,proof.scopeProofHash);
  for(const line of paragraph.lines){
   const anchor=traces.anchors.get(line.anchor.opIndex);
   if(!anchor||!traceEqual(anchor,line.anchor))return fail('reflow-context-unsupported: line anchor trace mismatch');
   for(const show of line.shows){const actual=traces.shows.get(`${show.source.opIndex}:${show.source.itemIndex}`);
    if(!actual||!traceEqual(actual.before,show.before)||!traceEqual(actual.after,show.after))return fail('reflow-context-unsupported: full show trace mismatch');
   }
  }
  // Until numeric-boundary redistribution is proven, permit only an original
  // leading TJ indent at the first show. Never split/drop an interior kern.
  if(proof.tjBoundaries.some(b=>b.left!==null||b.right?.opIndex!==proof.owned[0]?.opIndex||b.right?.itemIndex!==proof.owned[0]?.itemIndex))
   return fail('reflow-context-unsupported: interior/trailing TJ boundary cannot be redistributed');
  const byName=new Map(fonts.map(f=>[f.resourceName,f]));
  const walk=walkTextPlacements(ops,{resolveFont:name=>{const f=byName.get(name);return f?{...f,ok:true,appliesWordSpacing:f.bytesPerCode===1}:null;},
   extGStateSetsFont:name=>environment.extGStates?.get(name)?.setsFont??null});
  if(!walk.ok||walk.unplacedText)return fail('reflow-context-unsupported: unknown source placement');
  const owns=(s:SourceAddress,op:number,item:number)=>s.opIndex===op&&s.itemIndex===item;
  const glyphs=walk.glyphs.filter(g=>proof.owned.some(s=>owns(s,g.opIndex,g.arrayItemIndex)));
  if(glyphs.length>4096||request.sourceInk.length>4096||request.replacementInk.length>4096)
   return fail('reflow-context-unsupported: cluster/evidence budget');
  const selected=[...new Set(removalsByRect(walk.glyphs,overlay.coverRects).flatMap(s=>[...s]))];
  const targeted=glyphs.filter(g=>owns(target,g.opIndex,g.arrayItemIndex)&&g.byteOffset>=target.byteStart&&g.byteOffset<target.byteEnd);
  if(!targeted.length||targeted.length!==selected.length||selected.some(g=>!targeted.includes(g))||
   targeted[0]!.byteOffset!==target.byteStart||targeted.at(-1)!.byteOffset+targeted.at(-1)!.byteLength!==target.byteEnd)
   return fail('reflow-context-unsupported: selection does not equal the item-local target');
  const source:ReflowCodeCluster[]=[];
  for(const g of glyphs){
   const font=byName.get(g.fontName)!,line=paragraph.lines.findIndex(l=>l.shows.some(s=>owns(s.source,g.opIndex,g.arrayItemIndex)));
   const address:SourceAddress={...target,opIndex:g.opIndex,itemIndex:g.arrayItemIndex,byteStart:g.byteOffset,byteEnd:g.byteOffset+g.byteLength,fontObject:font.objectId};
   const evidence=request.sourceInk.find(e=>reflowAddressKey(e.source)===reflowAddressKey(address)&&e.source.streamHash===sourceHash);
   const unicode=font.unicodeByCode.get(g.code),o=g.coreQuad[0],advance=g.coreQuad[1].x-o.x;
   if(!unicode||!evidence?.proofHash||!validRect(evidence.box)||line<0||advance<0)return fail('glyph-bounds-unavailable: missing measured source ink/code');
   const absolute={...evidence.box,x:o.x+evidence.box.x,y:o.y+evidence.box.y};
   if(!paragraph.lines[line]!.ink||!contains(paragraph.lines[line]!.ink!,absolute))return fail('glyph-bounds-unavailable: source ink exceeds proven line envelope');
   const show=paragraph.lines[line]!.shows.find(s=>owns(s.source,g.opIndex,g.arrayItemIndex))!;
   const bytes=font.bytesPerCode===1?Uint8Array.of(g.code):Uint8Array.of(g.code>>8,g.code&255);
   source.push({unicode,code:bytes,fontResource:font.resourceName,fontObject:font.objectId,source:address,glyph:evidence.glyph,
    advance,ink:{...evidence.box},em:physicalSize(show.before),
    wordSpace:font.bytesPerCode===1&&g.code===32,fullEmHan:font.widthOf(g.code)===1000,gap:0,original:{line,x:o.x,y:o.y}});
  }
  if(source.length>4096)return fail('reflow-context-unsupported: cluster budget');
  for(let i=0;i<source.length-1;i++)if(source[i]!.original!.line===source[i+1]!.original!.line)
   source[i]!.gap=source[i+1]!.original!.x-source[i]!.original!.x-source[i]!.advance;
  for(const line of paragraph.lines)for(const show of line.shows)if(source.filter(t=>t.source&&owns(show.source,t.source.opIndex,t.source.itemIndex)).map(t=>t.unicode).join('')!==show.unicode)
   return fail('reflow-context-unsupported: paragraph source-code round trip differs');
  const start=glyphs.indexOf(targeted[0]!),end=glyphs.indexOf(targeted.at(-1)!)+1;
  const old=source.slice(start,end),sourceFont=byName.get(old[0]!.fontResource)!;
  const font=request.replacementFontResource?byName.get(request.replacementFontResource):sourceFont;
  if(!font)return fail('reflow-context-unsupported: measured replacement font is missing');
  const substituted=font.objectId!==sourceFont.objectId;
  if(old.map(t=>t.unicode).join('')!==overlay.originalText)return fail('reflow-context-unsupported: source text round trip differs');
  const owned=proof.owned.find(s=>owns(s,target.opIndex,target.itemIndex)&&s.fontObject===target.fontObject);
  if(!owned)return fail('reflow-context-unsupported: target is unowned');
  const op=ops[target.opIndex]!,item=op.operator==='TJ'&&op.operands[0]?.kind==='array'?op.operands[0].items[target.itemIndex]:op.operands[0];
  if(item?.kind!=='string')return fail('reflow-context-unsupported: target item missing');
  const {stage5Reflow:_,reflowRequest:__,...runEnvironment}=environment;void _;void __;
  const fixed:PageRunPlan={sourceHash,...runEnvironment,allowExistingCodePermutation:true,
   edits:[{fontResource:sourceFont.resourceName,fontObject:sourceFont.objectId,opIndex:target.opIndex,itemIndex:target.itemIndex,
    byteStart:target.byteStart,byteEnd:target.byteEnd,expected:item.bytes.slice(target.byteStart,target.byteEnd),replacement:replacementText}]};
  if(!substituted&&!replacementText.includes('\n')){
   const compiled=replaceRuns(content,fonts,fixed);
   if(compiled.ok)return {ok:true,plan:fixed};
   if(compiled.code!=='overflow')return {ok:false,code:compiled.code??'unsupported-state',reason:compiled.reason};
  }
  const base=old[0]!,replacement:ReflowCodeCluster[]=[];
  for(const {segment}of new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(replacementText)){
   if(segment==='\n'){if(!replacement.length||replacement.at(-1)!.hardAfter)return fail('reflow-break-unsupported: empty hard line');replacement.at(-1)!.hardAfter=true;continue;}
   const encoded=encodeRun(segment,font,substituted?new Uint8Array():item.bytes.slice(target.byteStart,target.byteEnd));
   if(!encoded.ok)return {ok:false,code:'font-coverage',reason:encoded.reason};
   if(encoded.codes.length!==1)return fail('reflow-break-unsupported: multi-code grapheme');
   const ink=request.replacementInk.find(e=>e.unicode===segment&&same(e.code,encoded.bytes));
   if(!ink?.proofHash||!validRect(ink.box))return fail('glyph-bounds-unavailable: replacement has no conservative ink');
   const state=traces.shows.get(`${target.opIndex}:${target.itemIndex}`)!.before;
   const scale=linear(state)[0]!*state.tz/100;
   const code=codes(encoded.bytes,font.bytesPerCode)[0]!,advance=(font.widthOf(code)*state.size/1000+state.tc+(font.bytesPerCode===1&&code===32?state.tw:0))*scale;
   replacement.push({...base,homeOp:base.source!.opIndex,fontResource:font.resourceName,fontObject:font.objectId,unicode:segment,code:encoded.bytes,source:undefined,original:undefined,glyph:undefined,
    advance,ink:{...ink.box},wordSpace:font.bytesPerCode===1&&code===32,fullEmHan:font.widthOf(code)===1000,hardAfter:false});
  }
  const layout=solveMeasuredReflow({source,replacement,start,end,proof,softBreaks:request.softBreaks});
  if(!layout.ok)return layout;
  const clusters=[...source.slice(0,start),...replacement,...source.slice(end)];
  const firstOp=target.opIndex,lastOp=proof.owned.at(-1)!.opIndex;
  const edits:PageRunPlan['edits'][number][]=[];
  for(const s of proof.owned.filter(s=>s.opIndex>=firstOp)){
   const showOp=ops[s.opIndex]!,showItem=showOp.operator==='TJ'&&showOp.operands[0]?.kind==='array'?showOp.operands[0].items[s.itemIndex]:showOp.operands[0];
   const f=fonts.find(f=>f.objectId===s.fontObject);
   if(!f||showItem?.kind!=='string')return fail('reflow-context-unsupported: missing owned show/font');
   edits.push({fontResource:f.resourceName,fontObject:f.objectId,opIndex:s.opIndex,itemIndex:s.itemIndex,
    byteStart:0,byteEnd:showItem.bytes.length,expected:showItem.bytes.slice(),replacement:''});
  }
  const last=paragraph.lines.at(-1)!.shows.at(-1)!,rejoin=last.after;
  const before=origin(last.before),after=origin(rejoin);
  if(!Number.isFinite(after[0]-before[0]))return fail('reflow-context-unsupported: invalid rejoin');
  return {ok:true,plan:{...fixed,edits,reflow:{...(substituted?{substituted:true}:{}),proof,request:structuredClone(request),saved:structuredClone(paragraph.lines[0]!.anchor),layout,clusters,firstOp,lastOp,rejoin:structuredClone(rejoin)}}};
 }catch(error){
  if(error instanceof ReflowTraceError)return fail(`reflow-context-unsupported: ${error.message}`);
  if(error instanceof RunCompileError)return {ok:false,code:error.code,reason:error.message};
  throw error;
 }
}
