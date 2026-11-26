import {PDFDict,PDFDocument,PDFName,PDFObjectCopier,type PDFPage} from 'pdf-lib';
import type {ContentTextOverlay} from '../../model/types';
import type {ContentTextOutcome} from './outcomes';
import {annotationAnchorRefusal, type AnchoredAnnotation} from '../sourceAnnotationAnchors';
import type {FallbackOptions} from '../contentStreamEdit/fallbackFont';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {walkTextPlacements} from '../contentStreamEdit/textState';
import {substitutionStamp} from '../contentStreamEdit/substituteSnapshot';
import {readVerticalSource,verticalAddress} from './verticalSource';
import {planVertical,layoutVertical,verticalHome} from './verticalPlan';
import {prepareVerticalFallback} from './verticalFallback';
import {emitVertical} from './verticalEmit';
import {retypesetScopes} from './retypesetScopes';
import {reflowScene} from './reflowScene';
import {bounds} from './retypesetInk';
import {contains,intersects,subtractRectangles} from './regionProof/geometry';
import {verticalPageFonts,type VerticalFont} from './verticalFont';
import {runContextSafety} from '../contentStreamEdit/replaceRun';
import {tightenedColumnOffsets,verticalFitScales} from './verticalSpacing';
import {sourceFontReader} from '../fonts/sourceFontContext';
import {fontRequestsForParagraph,forRegionalVerticalFace,resolveFont,withCachedLocalFonts,type FontChoice} from '../fonts/fontService';
import {mayHaveVerticalMetrics} from './verticalProgramMetrics';
import {fontChoiceKey} from '../fonts/localFonts';

/** The vertical compiler has its own placement proof and transaction. It
 * cannot route WMode 1 text through the horizontal layout or substitute path. */
export async function applyVerticalRetypesets(page:PDFPage,edits:readonly ContentTextOverlay[],outcomes:Map<string,ContentTextOutcome>,accepted:Set<string>,options:FallbackOptions,anchors:readonly AnchoredAnnotation[]=[]){
 const handled=new Set<string>(),content=inspectRunPage(page);if(!content.ok)return handled;
 const vertical=verticalPageFonts(page);if(!vertical.fonts.size)return handled;
 const ops=tokenizeContentStream(content.bytes);
 let source:ReturnType<typeof readVerticalSource>;
 try{source=readVerticalSource(page,ops,vertical);}catch(error){
  for(const edit of edits)if(!accepted.has(edit.id)){handled.add(edit.id);outcomes.set(edit.id,{overlayId:edit.id,mode:'unsupported',reason:'unsupported-vertical-writing',detail:String(error)});}
  return handled;
 }
 if(!source.walk.ok){
  for(const edit of edits)if(!accepted.has(edit.id)){handled.add(edit.id);outcomes.set(edit.id,{overlayId:edit.id,mode:'unsupported',reason:'unsupported-vertical-writing',detail:`vertical-writing-source: ${source.walk.reason}`});}
  return handled;
 }
 const candidates=edits.filter(e=>!accepted.has(e.id)&&source.glyphs.some(g=>g.box&&e.coverRects.some(r=>intersects(g.box!,r))));
 if(!candidates.length)return handled;
 const refuse=(e:ContentTextOverlay,error:unknown)=>{handled.add(e.id);outcomes.set(e.id,{overlayId:e.id,mode:'unsupported',reason:'unsupported-vertical-writing',detail:String(error)});};
 // All candidates share one immutable revision. Refuse conflicting column
 // ownership before preparing fonts or changing page resources.
 const planned: {edit:ContentTextOverlay;plan:NonNullable<ReturnType<typeof planVertical>>}[]=[];
 for(const edit of candidates)try{
  if(outcomes.get(edit.id)?.reason==='ambiguous-match')throw Error('vertical-source: ambiguous selection');
  if(outcomes.get(edit.id)?.reason==='stale-source')throw Error('vertical-source: stale source revision');
  const plan=planVertical(source,edit);if(plan)planned.push({edit,plan});
 }catch(error){refuse(edit,error);}
 for(const entry of planned)if(planned.some(other=>other!==entry&&other.plan.owned.some(g=>entry.plan.target.has(verticalAddress(g.glyph)))))refuse(entry.edit,'vertical-source: overlapping column edits');
 const independent=planned.filter(p=>!handled.has(p.edit.id));
 if(independent.length>1){for(const p of independent)refuse(p.edit,'vertical-source: multiple vertical paragraphs require one atomic column plan');return handled;}
 const readFont=sourceFontReader(page,ops),fontOptions=withCachedLocalFonts(options);
 for(const {edit,plan}of planned){
  if(handled.has(edit.id))continue;
  // A preceding installation changes source addresses. A fresh invocation
  // can batch further independent columns; this pass keeps the source fixed.
  if(accepted.has(edit.id))continue;
  try{
   const stamp=substitutionStamp(page),scratch=await PDFDocument.create();
   const groups=new Map<ReturnType<typeof fontChoiceKey>,{face:FontChoice;slots:[number,string][]}>();
   const withParagraph=fontRequestsForParagraph(plan.contextText);
   for(const [index,text]of Array.from(plan.text.replaceAll('\n','')).entries()){
    const {glyph,font}=verticalHome(plan,index);
    if(font.encode(text))continue;
    // The bundled Latin faces cannot supply a vertical advance or origin.
    const request=withParagraph({...readFont(glyph.fontName,glyph.opIndex),purpose:'vertical',text});
    const face=resolveFont(forRegionalVerticalFace(request,mayHaveVerticalMetrics),fontOptions);
    const key=fontChoiceKey(face),group=groups.get(key)??{face,slots:[]};
    group.slots.push([index,text]);groups.set(key,group);
   }
   const original=page.node.Resources(),fonts=original?.lookupMaybe(PDFName.of('Font'),PDFDict);
   const prepared=new Map<string,Awaited<ReturnType<typeof prepareVerticalFallback>>>(),fallback=new Map<number,VerticalFont>();
   let n=0;
   for(const {face,slots}of groups.values()){
    let name:string;do{name=`ShioriV${++n}`;}while(fonts?.has(PDFName.of(name)));
    const p=await prepareVerticalFallback(scratch,name,face,slots.map(([,text])=>text),fontOptions);
    prepared.set(name,p);
    for(const [index]of slots)fallback.set(index,p.font);
   }
   let layout=layoutVertical(plan,fallback);const scopes=retypesetScopes(ops);
   const media=page.getMediaBox(),crop=page.getCropBox(),pageBox={x:Math.max(media.x,crop.x),y:Math.max(media.y,crop.y),w:0,h:0};
   pageBox.w=Math.min(media.x+media.width,crop.x+crop.width)-pageBox.x;pageBox.h=Math.min(media.y+media.height,crop.y+crop.height)-pageBox.y;
   const scene:{box:typeof pageBox;kind:string}[]=[];
   reflowScene(page,ops,pageBox,(box,kind)=>{if(kind!=='backdrop')scene.push({box,kind});},.02);
   const fixed=[...source.glyphs.filter(g=>!plan.target.has(verticalAddress(g.glyph))).map(g=>g.box),...source.horizontalInk.map(i=>i.known?i.box:undefined)];
   if(fixed.some(b=>!b))throw Error('vertical-source: unproved stationary ink');
   // Semantic dependencies remain refused; rectangular clips get an explicit
   // containment proof instead of being silently removed from the stream.
   const unclippedOps=ops.map(o=>['W','W*'].includes(o.operator)?{...o,operator:'n',operands:[]}:o);
   const safety=runContextSafety(unclippedOps,source.environment);
   if(!safety.ok||plan.owned.some(g=>safety.unsafe.has(g.glyph.opIndex)))throw Error('vertical-source: graphics or semantic dependency');
   for(const g of plan.owned){const clip=scopes.get(g.glyph.opIndex)?.clip;if(clip===null||clip&&!contains(clip,g.box!))throw Error('vertical-clip: source ink is not wholly inside a proved clip');}
   const prove=(atoms:typeof layout.atoms,fit=false)=>{
   for(const a of atoms){
    if(!contains(pageBox,a.box))throw Error('vertical-crop-media: destination ink leaves page bounds');
    if(!contains(pageBox,{...a.pen,w:0,h:0}))throw Error('vertical-crop-media: destination text pen leaves page bounds');
    const clip=scopes.get(a.home.glyph.opIndex)?.clip;
    if(clip===null||clip&&!contains(clip,a.box))throw Error('vertical-clip: destination ink escapes its source clip');
    // The declared edit mask bounds all new paint. No post-layout mask growth.
    if(subtractRectangles(a.box,edit.coverRects).length)throw Error('vertical-mask: destination ink leaves the declared edit mask');
    if(fixed.some(b=>intersects(b!,a.box))||scene.some(o=>intersects(o.box,a.box)))throw Error('vertical-obstacle: destination overlaps unpushed ink; a following-column push is unproved');
   }
   if(atoms.some((a,i)=>atoms.slice(i+1).some(b=>intersects(a.box,b.box))))throw Error('vertical-glyph: output ink overlaps');
   if(fit){
    const em=plan.first.state.fontSize*plan.scale.x,cx=atoms[0]!.pen.x;
    const band=bounds([{x:cx-em/2,y:atoms[0]!.pen.y},{x:cx+em/2,y:atoms[0]!.pen.y},...atoms.flatMap(a=>[a.pen,{x:a.box.x,y:a.box.y},{x:a.box.x+a.box.w,y:a.box.y+a.box.h}])]);
    if(!contains(pageBox,band))throw Error('vertical-crop-media: fitted column band leaves page bounds');
    if(fixed.some(b=>intersects(b!,band))||scene.some(o=>intersects(o.box,band)))throw Error('vertical-obstacle: fitted column band is not empty');
   }
   };
   try{prove(layout.atoms);}catch(error){
    if(!/^vertical-(mask|clip|crop-media|obstacle):/u.test((error as Error).message)||plan.columns!==1||edit.text.includes('\n'))throw error;
    const em=plan.first.state.fontSize*plan.scale.y,step=plan.capacity/plan.owned.length;
    let fitted:typeof layout|undefined,last=error;
    for(const scale of verticalFitScales()){
     const straight=layoutVertical(plan,fallback,true,scale);
     const offsetsList=function*(){if(scale<1)yield straight.atoms.map(()=>0);yield* tightenedColumnOffsets(straight.atoms.map(a=>({y:a.pen.y,boxes:[a.box]})),em*scale,step);};
     for(const offsets of offsetsList()){
      const atoms=straight.atoms.map((a,i)=>({...a,pen:{...a.pen,y:a.pen.y+offsets[i]!},box:{...a.box,y:a.box.y+offsets[i]!}}));
      try{prove(atoms,true);fitted={...straight,atoms,overflowed:true};break;}catch(refusal){last=refusal;}
     }
     if(fitted)break;
    }
    if(!fitted)throw last===error?error:Error(`${(error as Error).message}; fit: ${(last as Error).message}`);layout=fitted;
   }
   const bytes=emitVertical(content.bytes,ops,source,plan.owned.map(g=>g.glyph),layout.atoms);
   const verify=walkTextPlacements(tokenizeContentStream(bytes),{resolveFont:name=>prepared.get(name)?.font??source.resolveFont(name),extGStateSetsFont:name=>source.environment.extGStates?.get(name)?.setsFont??null});
   if(!verify.ok||verify.unplacedText||!source.walk.ok)throw Error('vertical-source: compiled placements are unproved');
   const remaining=[...verify.glyphs];
   const close=(a:{x:number;y:number},b:{x:number;y:number})=>Math.hypot(a.x-b.x,a.y-b.y)<1e-4;
   for(const g of source.walk.glyphs.filter(g=>!plan.target.has(verticalAddress(g)))){
    const index=remaining.findIndex(c=>c.fontName===g.fontName&&c.code===g.code&&c.quad.every((p,i)=>close(p,g.quad[i]!)));
    if(index<0)throw Error('vertical-source: compiled stream moved an untargeted glyph');remaining.splice(index,1);
   }
   for(const a of layout.atoms){const index=remaining.findIndex(g=>g.fontName===a.font.resourceName&&g.code===a.code&&g.pen&&close(g.pen,a.pen));if(index<0)throw Error('vertical-source: compiled output origin differs');remaining.splice(index,1);}
   if(remaining.length)throw Error('vertical-source: compiled stream introduced unexplained glyphs');
   const current=inspectRunPage(page);
   if(!current.ok||current.sourceHash!==content.sourceHash||substitutionStamp(page)!==stamp)throw Error('vertical-source: page changed during font preparation');
   const paragraphBox=bounds([...plan.owned.flatMap(g=>g.glyph.quad),...[...plan.owned.map(g=>g.box!),...layout.atoms.map(a=>a.box)].flatMap(b=>[{x:b.x,y:b.y},{x:b.x+b.w,y:b.y+b.h}])]);
   const anchor=annotationAnchorRefusal(anchors,[paragraphBox]);
   if(anchor){outcomes.set(edit.id,{overlayId:edit.id,mode:'unsupported',...anchor});handled.add(edit.id);continue;}
   const resources=original?.clone()??page.doc.context.obj({}),installedFonts=fonts?.clone()??page.doc.context.obj({});
   const copier=PDFObjectCopier.for(scratch.context,page.doc.context);
   for(const [name,p]of prepared)installedFonts.set(PDFName.of(name),copier.copy(p.ref));
   const fallbackNames=new Set([...prepared.values()].map(p=>p.name));
   resources.set(PDFName.of('Font'),installedFonts);page.node.set(PDFName.of('Resources'),resources);
   page.node.set(PDFName.of('Contents'),page.doc.context.register(page.doc.context.flateStream(bytes)));
   accepted.add(edit.id);handled.add(edit.id);
   outcomes.set(edit.id,{overlayId:edit.id,mode:'retypeset',fidelity:'approximate',retypeset:{reason:outcomes.get(edit.id)?.reason??'unsupported-vertical-writing',paragraphBox,substituteFont:fallbackNames.size?[...fallbackNames].join(', '):null,lineCount:layout.columns,overflowed:layout.overflowed,pushed:false,pushedDeltaPt:0,pushedRegions:[],overflowInkOverlap:false,unchangedLineDriftPt:0,quality:{maxUnchangedLineStartXDriftPt:0,maxUnchangedLineBaselineDriftPt:0,overflowInkOverlap:false}}});
  }catch(error){refuse(edit,error);}
 }
 return handled;
}
