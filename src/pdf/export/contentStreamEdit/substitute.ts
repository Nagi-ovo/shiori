import fontkit from '@pdf-lib/fontkit';
import {PDFDocument,PDFDict,PDFName,PDFObjectCopier,type PDFPage} from 'pdf-lib';
import type {ContentTextOverlay} from '../../model/types';
import {compilerReason,type ContentTextOutcome} from '../contentText/outcomes';
import {prepareFallback,type FallbackOptions} from './fallbackFont';
import {loadBundledFallbackFont} from './fallbackAssets';
import {inspectRunPage,runPageEnvironment} from './replaceRunPage';
import {replaceRuns} from './replaceRun';
import {substitutionStamp} from './substituteSnapshot';
import {RunCompileError} from './runRefusal';
import {substituteSourceFonts} from './substituteSource';
import {planSubstitution,type SubstituteLine} from './substitutePlan';
import {substituteInk} from './substituteInk';
import {planStreamReflow} from '../contentText/reflowAuto';
import {compileReflowPlan} from '../contentText/reflowCompile';
import {reflowManifest} from '../contentText/reflowManifest';
import {reflowEnabled} from '../contentText/reflowTypes';
import type {AppliedReflowManifest} from '../contentText/reflowManifest';
import type {Type1Options} from '../fontCoverage/type1Support';
import {tokenizeContentStream} from './tokenizer';
import {walkTextPlacements} from './textState';
import {intersects} from '../contentText/regionProof/geometry';

export type SubstituteOptions=FallbackOptions&{stage5Substitute?:boolean;stage5Reflow?:boolean;stage5Type1?:Type1Options};
const clusters=(text:string)=>[...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text)].map(s=>s.segment);
function checkSlot(line:SubstituteLine,font:Awaited<ReturnType<typeof prepareFallback>>['resolved'],data:Uint8Array,overlay:ContentTextOverlay){
 const parsed=fontkit.create(data),scale=line.state.advanceVector.x,size=line.state.fontSize;
 let advance=0;
 for(const cluster of clusters(line.text)){
  const encoded=font.canEncode!(cluster);if(!encoded.ok)throw new RunCompileError('substitute cluster unavailable','font-coverage');
  const code=encoded.bytes[0]!*256+encoded.bytes[1]!,glyph=parsed.layout(cluster).glyphs[0]!,box=glyph.path.bbox;
  if(!/^\s+$/u.test(cluster)){
   const unit=size/parsed.unitsPerEm,x=line.origin.x+advance*size*scale/1000,y=line.origin.y,vertical=(line.state.fontSizePt??size)/parsed.unitsPerEm;
   const left=x+box.minX*unit*scale,right=x+box.maxX*unit*scale,bottom=y+box.minY*vertical,top=y+box.maxY*vertical;
   // Half a point reserves raster antialiasing beyond the outline bounds.
   if(!overlay.coverRects.some(r=>left>=r.x+.5&&right<=r.x+r.w-.5&&bottom>=r.y+.5&&top<=r.y+r.h-.5))throw new RunCompileError('substitute ink exceeds original cover','overflow');
  }
  advance+=font.widthOf(code)+1000*line.state.charSpacing/size;
 }
 const neededPt=advance*size*scale/1000;
 if(!Number.isFinite(neededPt)||neededPt<0||neededPt>line.availablePt+1e-7)throw new RunCompileError('substitute run overflows original slot','overflow');
}
async function substitute(page:PDFPage,overlay:ContentTextOverlay,options:SubstituteOptions,siblings:readonly ContentTextOverlay[]):Promise<ContentTextOutcome>{
 const source=inspectRunPage(page);
 const refusal=(reason:NonNullable<ContentTextOutcome['reason']>,detail:string):ContentTextOutcome=>({overlayId:overlay.id,mode:'overlay',reason,detail});
 if(!source.ok)return refusal(source.code,source.reason);
 const originalResources=page.node.Resources(),originalContents=page.node.get(PDFName.of('Contents')),stamp=substitutionStamp(page);
 try{
  const fonts=substituteSourceFonts(page),environment=runPageEnvironment(page),plan=planSubstitution(source.bytes,fonts,overlay,environment,substituteInk(page,fonts));
  const name=plan.lines[0]!.fontName;
  if(plan.lines.some(l=>l.fontName!==name))throw new RunCompileError('mixed substitute faces require paragraph style planning','unsupported-state');
  const fontDict=originalResources?.lookupMaybe(PDFName.of('Font'),PDFDict);
  let index=1;while(fontDict?.has(PDFName.of(`ShioriSub${index}`)))index++;
  const resource=`ShioriSub${index}`,scratch=await PDFDocument.create();
  const data=await (options.loadFont??loadBundledFallbackFont)(name);
  const prepared=await prepareFallback(scratch,resource,name,[...new Set(plan.lines.flatMap(l=>clusters(l.text)))],{loadFont:async()=>data});
  let overflow:RunCompileError|undefined;
  try{for(const line of plan.lines)checkSlot(line,prepared.resolved,data,overlay);}catch(error){
   if(!(error instanceof RunCompileError)||error.code!=='overflow')throw error;
   overflow=error;
  }
  // Capacity is checked over each owned line above. Later owned items are
  // blanked; the span compiler restores every item's original endpoint.
  let manifest:AppliedReflowManifest|undefined;
  let compiled;
  if(overflow){
   if(!reflowEnabled(options.stage5Reflow))throw overflow;
   // The complete source/resource scene and NEW font coexist only on this
   // scratch page. Planning/compilation never mutates the destination page.
   const copy=PDFObjectCopier.for(page.doc.context,scratch.context),candidate=scratch.addPage([page.getWidth(),page.getHeight()]);
   for(const key of ['Resources','Contents','Annots'] as const){
    const value=key==='Resources'?originalResources:page.node.get(PDFName.of(key));if(value)candidate.node.set(PDFName.of(key),copy.copy(value));
   }
   const media=page.getMediaBox(),crop=page.getCropBox();candidate.setMediaBox(media.x,media.y,media.width,media.height);candidate.setCropBox(crop.x,crop.y,crop.width,crop.height);
   const resources=candidate.node.Resources()??scratch.context.obj({}),dict=resources.lookupMaybe(PDFName.of('Font'),PDFDict)??scratch.context.obj({});
   dict.set(PDFName.of(resource),prepared.ref);resources.set(PDFName.of('Font'),dict);candidate.node.set(PDFName.of('Resources'),resources);
   const measured=[...substituteSourceFonts(candidate).filter(f=>f.resourceName!==resource),prepared.resolved],env=runPageEnvironment(candidate);
   const recipe=planStreamReflow(candidate,source.bytes,measured,overlay,{...env,stage5Reflow:true},options.stage5Type1,prepared.resolved);
   if(!recipe?.reflow)throw overflow;
   if(siblings.some(o=>o.id!==overlay.id&&o.coverRects.some(r=>intersects(r,recipe.reflow!.proof.box))))return refusal('shared-text-object','substitute reflow intersects another overlay');
   compiled=compileReflowPlan(source.bytes,measured,recipe);
   if(compiled.ok){
    const walk=walkTextPlacements(tokenizeContentStream(source.bytes),{resolveFont:name=>{const f=measured.find(f=>f.resourceName===name);return f?{...f,ok:true,appliesWordSpacing:f.bytesPerCode===1}:{ok:false,reason:'unmeasurable source font'};},extGStateSetsFont:name=>env.extGStates?.get(name)?.setsFont??null});
    if(!walk.ok)throw overflow;
    manifest=reflowManifest(recipe.reflow,walk.glyphs,measured);
   }
  }else compiled=replaceRuns(source.bytes,fonts,{sourceHash:source.sourceHash,...environment,edits:plan.edits,allowOverflow:true,fallbackFonts:[prepared.resolved]});
  if(!compiled.ok)return refusal(compilerReason(compiled),compiled.reason);
  const current=inspectRunPage(page);
  if(!current.ok||current.sourceHash!==source.sourceHash||page.node.Resources()!==originalResources||page.node.get(PDFName.of('Contents'))!==originalContents||substitutionStamp(page)!==stamp)return refusal('stale-source','page changed during substitution preparation');
  const resources=originalResources?.clone()??page.doc.context.obj({}),patchedFonts=fontDict?.clone()??page.doc.context.obj({});
  const copier=PDFObjectCopier.for(scratch.context,page.doc.context);
  patchedFonts.set(PDFName.of(resource),copier.copy(prepared.ref));resources.set(PDFName.of('Font'),patchedFonts);
  const stream=page.doc.context.register(page.doc.context.flateStream(compiled.bytes));
  page.node.set(PDFName.of('Resources'),resources);page.node.set(PDFName.of('Contents'),stream);
  return {overlayId:overlay.id,mode:'substituted',...(manifest?{reflow:manifest}:{})};
 }catch(error){
  if(!(error instanceof RunCompileError))throw error;
  return refusal(error.code,error.message);
 }
}
/** Post-refusal only; the existing transactional reflow batch runs first. */
export async function applyFontSubstitutions(page:PDFPage,edits:readonly ContentTextOverlay[],outcomes:Map<string,ContentTextOutcome>,accepted:Set<string>,options:SubstituteOptions){
 if(options.stage5Substitute===false)return;
 for(const overlay of edits){
  const outcome=outcomes.get(overlay.id);
  if(outcome?.mode!=='overlay'||!['font-unavailable','font-coverage'].includes(outcome.reason??''))continue;
  const result=await substitute(page,overlay,options,edits);outcomes.set(overlay.id,result);
  if(result.mode==='substituted')accepted.add(overlay.id);
 }
}
