import type {PDFPage} from 'pdf-lib';
import {applyVerticalRetypesets} from './vertical';
import {applyUprightColumnRetypesets} from './uprightColumn';
import {substituteSourceFonts} from '../contentStreamEdit/substituteSource';
import type {ContentTextOverlay} from '../../model/types';
import type {SubstituteOptions} from '../contentStreamEdit/substitute';
import type {ContentTextOutcome} from './outcomes';
import {address,paragraphGroups,readRetypesetSource} from './retypesetSource';
import {planRetypeset,selectRetypeset} from './retypesetPlan';
import {textFormNames,imageOverlaps,imageFormNames,formImageOverlaps} from './retypesetLayers';
import {prepareRetypesetWrite,RETYPESET_SIZE_UNMET} from './retypesetWrite';
import {readRetypesetStreams,pageFormGlyphs,formPageBox,type RetypesetStream} from './retypesetForms';
import {installRetypesetForms,retypesetFormStamp} from './retypesetFormCow';
import type {RetypesetEdit,RetypesetManifest} from './retypesetTypes';
import {addRetypesetBatch,type RetypesetBatch} from './retypesetBatches';
import {annotationAnchorRefusal,readSourceAnnotationAnchors,retypesetAffectedBoxes,type AnchoredAnnotation} from '../sourceAnnotationAnchors';
/** All outstanding edits in a paragraph share one layout and one transaction.
 * Each Form occurrence has its own stream-local namespace and CoW path. */
export async function applyRetypesets(page:PDFPage,edits:readonly ContentTextOverlay[],outcomes:Map<string,ContentTextOutcome>,accepted:Set<string>,options:SubstituteOptions,protectArtwork=false,anchors:readonly AnchoredAnnotation[]=readSourceAnnotationAnchors(page)){
 if(edits.every(e=>accepted.has(e.id)))return;
 const verticalHandled=protectArtwork?new Set<string>():await applyVerticalRetypesets(page,edits,outcomes,accepted,options,anchors);
 const columnHandled=protectArtwork?new Set<string>():await applyUprightColumnRetypesets(page,edits.filter(e=>!verticalHandled.has(e.id)),outcomes,accepted,options,anchors);
 const pending=edits.filter(e=>!accepted.has(e.id)&&!verticalHandled.has(e.id)&&!columnHandled.has(e.id));if(!pending.length)return;
 const refuse=(e:ContentTextOverlay,reason:ContentTextOutcome['reason'],detail?:string)=>outcomes.set(e.id,{overlayId:e.id,mode:'unsupported',reason,detail});
 try{
  const stamp=retypesetFormStamp(page),tree=readRetypesetStreams(page,options.stage5Type1);
  const vertical=tree.nodes.flatMap(n=>[...n.read.verticalFonts]);
  if(!tree.root.read.walk.ok)throw Error(tree.root.read.walk.reason);
  const forms=textFormNames(page),hasForms=tree.root.read.walk.xobjects.some(o=>forms.has(o.name));
  const imageForms=imageFormNames(page),formImages=tree.root.read.walk.xobjects.filter(o=>imageForms.has(o.name));
  const projected=new Map(tree.nodes.map(node=>[node,pageFormGlyphs(node)]));
  let measuredStandard:ReturnType<typeof readRetypesetSource>|undefined;
  let type3:string[]|undefined;const type3Text=()=>type3??=substituteSourceFonts(page,{flippedType3:true}).filter(f=>f.glyphFlipY).map(f=>f.resourceName);
  const byNode=new Map<RetypesetStream,RetypesetBatch<RetypesetEdit>[]>();
  for(const e of pending){
   if(outcomes.get(e.id)?.reason==='stale-source'){refuse(e,'unsupported-unwritable','stale source revision');continue;}
   const selections=tree.nodes.flatMap(node=>{const hits=selectRetypeset(projected.get(node)!,e);return hits.length?[{node,hits}]:[];});
   if(!selections.length&&vertical.length){refuse(e,'unsupported-vertical-writing',vertical.join('; '));continue;}
   if(vertical.length){refuse(e,'unsupported-unwritable','unplaced vertical source ink prevents a horizontal occupancy proof');continue;}
   if(!selections.length&&!hasForms&&!tree.errors.length&&!tree.nodes.some(n=>n.read.glyphs.length)&&type3Text().length){
    // ToUnicode Type 3 glyphs are text. Only upright columns over them are proved.
    // Covers cut at the page edge address a column laid out past the page
    // (Chromium multicol overflow): no visible column is selected.
    const media=page.getMediaBox(),crop=page.getCropBox(),x0=Math.max(media.x,crop.x),y0=Math.max(media.y,crop.y),x1=Math.min(media.x+media.width,crop.x+crop.width),y1=Math.min(media.y+media.height,crop.y+crop.height);
    const clamped=e.coverRects.some(r=>r.x<=x0+.01||r.y<=y0+.01||r.x+r.w>=x1-.01||r.y+r.h>=y1-.01);
    refuse(e,'unsupported-unwritable',`type3-text: ${type3Text().length} y-mirrored Type 3 font(s) with ToUnicode; ${clamped?'the selection is cut at the page edge, so its column lies outside the page':'this selection is not an upright column the column compiler can prove'}`);continue;
   }
   const imageBehind=tree.images.some(o=>imageOverlaps(o.matrix,e.coverRects))||formImages.some(o=>formImageOverlaps(page,o.name,o.ctm,e.coverRects));
   if(!selections.length){
    // Published standard metrics can identify source text for diagnostics.
    // The page writer still requires independent reader observations.
    measuredStandard??=readRetypesetSource(tree.root.page,tree.root.ops,{...options.stage5Type1,standard14Afm:true});
    const hits=selectRetypeset(measuredStandard.glyphs,e);
    if(imageBehind&&hits.some(g=>g.state.renderMode===3)){refuse(e,'unsupported-image-text');continue;}
    const hasLabel=(text:string|undefined)=>text!==undefined&&/[^\s\ufffd]/u.test(text);
    const readable=hits.some(g=>hasLabel(g.text))||e.sourceGlyphs?.some(g=>hasLabel(g.text)&&
     e.coverRects.some(r=>g.x>=r.x-.05&&g.x<r.x+r.w&&g.y>=r.y-.05&&g.y<=r.y+r.h));
    const reason=hasForms||tree.errors.length?'unsupported-form-xobject':readable?'unsupported-unverified-text':
     tree.nodes.some(n=>n.read.glyphs.length)?'unsupported-unwritable':'unsupported-no-text-layer';
    refuse(e,reason,tree.errors.join('; ')||(readable?'source positions could not be verified':'no walkable glyphs at selection'));continue;
   }
   if(selections.length!==1){refuse(e,'unsupported-form-xobject','selection spans multiple content stream occurrences');continue;}
   const {node,hits}=selections[0]!,read=node.read;
   if(protectArtwork&&node!==tree.root)continue;
   if(node.raw&&(!read.walk.ok||read.walk.unplacedText)){refuse(e,'unsupported-form-xobject','cannot verify every untargeted glyph in the Form');continue;}
   const selected=hits.map(g=>read.glyphs.find(local=>address(local.glyph)===address(g.glyph))!);
   if(imageBehind&&selected.some(g=>g.state.renderMode===3)){refuse(e,'unsupported-image-text');continue;}
   const frame=paragraphGroups(read.glyphs,node.ops,selected[0]!,selected);
   if(!frame.group)throw Error('no paragraph at selection');
   const list=byNode.get(node)??[];if(!byNode.has(node))byNode.set(node,list);
   const prior=outcomes.get(e.id);
   addRetypesetBatch(list,frame.group,{overlay:e,selected,reason:prior?.reason??'unsupported-state',...(prior?.exactGate?{exactGate:prior.exactGate,exactGateDetail:prior.exactGateDetail}:{}),...(prior?.substituteGate?{substituteGate:prior.substituteGate}:{}),
    ...(prior?.detail?{refusalDetail:prior.detail}:{}),...(prior?.unsafeOperator?{unsafeOperator:prior.unsafeOperator}:{})});
  }
  const planned=new Map<RetypesetStream,{edits:RetypesetEdit[];plan:ReturnType<typeof planRetypeset>}[]>();
  for(const [node,batches]of byNode)for(const {members:edits}of batches)try{
   const plan=planRetypeset(node.read.glyphs,node.ops,edits);
   if(protectArtwork){
    const native=edits[0]?.overlay.sourceGlyphs;
    if(edits.length!==1||plan.tail.some(g=>!g.text||g.text.trim()&&
     !native?.some(n=>n.text===g.text&&Math.abs(n.x-g.glyph.coreQuad[0].x)<.05&&Math.abs(n.y-g.glyph.coreQuad[0].y)<.05)))continue;
   }
   const plans=planned.get(node)??[];plans.push({edits,plan});planned.set(node,plans);
  }catch(error){for(const e of edits)refuse(e.overlay,'unsupported-unwritable',String(error));}
  const results:{edits:RetypesetEdit[];manifest:Omit<RetypesetManifest,'reason'>;strippedEquivalentIds?:string[]}[]=[];
  const idle=(plan:ReturnType<typeof planRetypeset>):Awaited<ReturnType<typeof prepareRetypesetWrite>>['manifests'][number]=>{
   const points=plan.group.lines.flatMap(l=>l.glyphs.flatMap(g=>g.glyph.quad)),x=Math.min(...points.map(p=>p.x)),y=Math.min(...points.map(p=>p.y)),right=Math.max(...points.map(p=>p.x)),top=Math.max(...points.map(p=>p.y));
   return {paragraphBox:{x,y,w:right-x,h:top-y},substituteFont:null,lineCount:plan.group.lines.length,overflowed:false,pushed:false,pushedDeltaPt:0,pushedRegions:[],pushReason:undefined,overflowInkOverlap:false,unchangedLineDriftPt:0,quality:{maxUnchangedLineStartXDriftPt:0,maxUnchangedLineBaselineDriftPt:0,overflowInkOverlap:false}};
  };
  for(const [node,plans]of planned)try{
   let writable=plans.filter(p=>p.plan.blocks.length);
   const manifests=new Map(plans.filter(p=>!p.plan.blocks.length).map(p=>[p,idle(p.plan)]));
   while(writable.length){
    const candidate=await prepareRetypesetWrite(node.page,node.bytes,node.ops,node.read,writable.map(p=>p.plan),options,byNode.size>1?'multiple-stream-edits':accepted.size?'other-edited-content':undefined,!protectArtwork,protectArtwork);
    const remaining=anchors.length?writable.filter((p,i)=>{
     const boxes=retypesetAffectedBoxes(candidate.manifests[i]!).map(box=>formPageBox(node.matrix,box));
     const anchor=annotationAnchorRefusal(anchors,boxes);
     if(!anchor)return true;
     for(const {overlay}of p.edits)outcomes.set(overlay.id,{overlayId:overlay.id,mode:'unsupported',...anchor});
     return false;
    }):writable;
    if(remaining.length===writable.length){
     candidate.install();
     node.changed=true;
     writable.forEach((p,i)=>manifests.set(p,candidate.manifests[i]!));
     break;
    }
    writable=remaining;
   }
   for(const [p,{strippedEquivalentIds,...manifest}]of manifests){
    const m=node.matrix,q=manifest.quality;
    const residualX=Math.abs(m[0]!)*q.maxUnchangedLineStartXDriftPt+Math.abs(m[2]!)*q.maxUnchangedLineBaselineDriftPt;
    const residualY=Math.abs(m[1]!)*q.maxUnchangedLineStartXDriftPt+Math.abs(m[3]!)*q.maxUnchangedLineBaselineDriftPt;
    results.push({edits:p.edits,strippedEquivalentIds,manifest:{...manifest,paragraphBox:formPageBox(node.matrix,manifest.paragraphBox),
     pushedDeltaPt:manifest.pushedDeltaPt*Math.hypot(node.matrix[2]!,node.matrix[3]!),
     unchangedLineDriftPt:Math.max(residualX,residualY,Math.abs(m[2]!)*manifest.pushedDeltaPt,Math.abs(m[3]!)*manifest.pushedDeltaPt),
     quality:{...q,maxUnchangedLineStartXDriftPt:residualX,maxUnchangedLineBaselineDriftPt:residualY},
     pushedRegions:manifest.pushedRegions.map(r=>({before:formPageBox(node.matrix,r.before),after:formPageBox(node.matrix,r.after)}))}});
   }
  }catch(error){for(const p of plans)for(const e of p.edits)if(outcomes.get(e.overlay.id)?.reason!=='annotation-anchor')refuse(e.overlay,String(error).includes(RETYPESET_SIZE_UNMET)?'style-change':'unsupported-unwritable',String(error));}
  if(!results.length)return;
  if(retypesetFormStamp(page)!==stamp)throw Error('page or Form resources changed during retypeset preparation');
  installRetypesetForms(page,tree.root);
  for(const {edits,manifest,strippedEquivalentIds}of results)for(const e of edits){accepted.add(e.overlay.id);outcomes.set(e.overlay.id,{overlayId:e.overlay.id,mode:'retypeset',fidelity:'approximate',
   ...(strippedEquivalentIds?.includes(e.overlay.id)?{strippedEquivalent:true}:{}),retypeset:{...manifest,reason:e.reason,...(e.exactGate?{exactGate:e.exactGate,...(e.exactGateDetail?{exactGateDetail:e.exactGateDetail}:{})}:{}),...(e.substituteGate?{substituteGate:e.substituteGate}:{}),
   ...(e.refusalDetail?{refusalDetail:e.refusalDetail}:{}),...(e.unsafeOperator?{unsafeOperator:e.unsafeOperator}:{})}});}
 }catch(error){for(const e of pending)if(!accepted.has(e.id)&&outcomes.get(e.id)?.reason!=='annotation-anchor')refuse(e,'unsupported-unwritable',String(error));}
}
