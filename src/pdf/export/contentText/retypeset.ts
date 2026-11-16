import type {PDFPage} from 'pdf-lib';
import type {ContentTextOverlay} from '../../model/types';
import type {SubstituteOptions} from '../contentStreamEdit/substitute';
import type {ContentTextOutcome} from './outcomes';
import {address,paragraphGroups} from './retypesetSource';
import {planRetypeset,selectRetypeset} from './retypesetPlan';
import {textFormNames,imageOverlaps,imageFormNames,formImageOverlaps} from './retypesetLayers';
import {writeRetypeset} from './retypesetWrite';
import {readRetypesetStreams,pageFormGlyphs,formPageBox,type RetypesetStream} from './retypesetForms';
import {installRetypesetForms,retypesetFormStamp} from './retypesetFormCow';
import type {RetypesetEdit} from './retypesetTypes';
import {addRetypesetBatch,type RetypesetBatch} from './retypesetBatches';
/** All outstanding edits in a paragraph share one layout and one transaction.
 * Each Form occurrence has its own stream-local namespace and CoW path. */
export async function applyRetypesets(page:PDFPage,edits:readonly ContentTextOverlay[],outcomes:Map<string,ContentTextOutcome>,accepted:Set<string>,options:SubstituteOptions){
 const pending=edits.filter(e=>!accepted.has(e.id));if(!pending.length)return;
 const refuse=(e:ContentTextOverlay,reason:ContentTextOutcome['reason'],detail?:string)=>outcomes.set(e.id,{overlayId:e.id,mode:'unsupported',reason,detail});
 try{
  const stamp=retypesetFormStamp(page),tree=readRetypesetStreams(page,options.stage5Type1);
  const vertical=tree.nodes.flatMap(n=>[...n.read.verticalFonts]);
  if(vertical.length){for(const e of pending)refuse(e,'unsupported-vertical-writing',vertical.join('; '));return;}
  if(!tree.root.read.walk.ok)throw Error(tree.root.read.walk.reason);
  const forms=textFormNames(page),hasForms=tree.root.read.walk.xobjects.some(o=>forms.has(o.name));
  const imageForms=imageFormNames(page),formImages=tree.root.read.walk.xobjects.filter(o=>imageForms.has(o.name));
  const projected=new Map(tree.nodes.map(node=>[node,pageFormGlyphs(node)]));
  const byNode=new Map<RetypesetStream,RetypesetBatch<RetypesetEdit>[]>();
  for(const e of pending){
   if(outcomes.get(e.id)?.reason==='stale-source'){refuse(e,'unsupported-unwritable','stale source revision');continue;}
   const selections=tree.nodes.flatMap(node=>{const hits=selectRetypeset(projected.get(node)!,e);return hits.length?[{node,hits}]:[];});
   if(!selections.length&&tree.nodes.some(n=>n.read.verticalShows.length)){refuse(e,'unsupported-unwritable','vertical-writing-unsupported-retypeset: WMode 1 / Identity-V emission is not supported');continue;}
   if(!selections.length){refuse(e,hasForms||tree.errors.length?'unsupported-form-xobject':!tree.nodes.some(n=>n.read.glyphs.length)?'unsupported-no-text-layer':'unsupported-unwritable',tree.errors.join('; ')||'no walkable glyphs at selection');continue;}
   if(selections.length!==1){refuse(e,'unsupported-form-xobject','selection spans multiple content stream occurrences');continue;}
   const {node,hits}=selections[0]!,read=node.read;
   if(node.raw&&(!read.walk.ok||read.walk.unplacedText)){refuse(e,'unsupported-form-xobject','cannot verify every untargeted glyph in the Form');continue;}
   const selected=hits.map(g=>read.glyphs.find(local=>address(local.glyph)===address(g.glyph))!);
   const imageBehind=tree.images.some(o=>imageOverlaps(o.matrix,e.coverRects))||formImages.some(o=>formImageOverlaps(page,o.name,o.ctm,e.coverRects));
   if(imageBehind&&selected.some(g=>g.state.renderMode===3)){refuse(e,'unsupported-image-text');continue;}
   const frame=paragraphGroups(read.glyphs,node.ops,selected[0]!,selected);
   if(!frame.group)throw Error('no paragraph at selection');
   const list=byNode.get(node)??[];if(!byNode.has(node))byNode.set(node,list);
   addRetypesetBatch(list,frame.group,{overlay:e,selected,reason:outcomes.get(e.id)?.reason??'unsupported-state'});
  }
  const planned=new Map<RetypesetStream,{edits:RetypesetEdit[];plan:ReturnType<typeof planRetypeset>}[]>();
  for(const [node,batches]of byNode)for(const {members:edits}of batches)try{
   const plans=planned.get(node)??[];plans.push({edits,plan:planRetypeset(node.read.glyphs,node.ops,edits)});planned.set(node,plans);
  }catch(error){for(const e of edits)refuse(e.overlay,'unsupported-unwritable',String(error));}
  const results:{edits:RetypesetEdit[];manifest:Awaited<ReturnType<typeof writeRetypeset>>[number]}[]=[];
  const idle=(plan:ReturnType<typeof planRetypeset>):Awaited<ReturnType<typeof writeRetypeset>>[number]=>{
   const points=plan.group.lines.flatMap(l=>l.glyphs.flatMap(g=>g.glyph.quad)),x=Math.min(...points.map(p=>p.x)),y=Math.min(...points.map(p=>p.y)),right=Math.max(...points.map(p=>p.x)),top=Math.max(...points.map(p=>p.y));
   return {paragraphBox:{x,y,w:right-x,h:top-y},substituteFont:null,lineCount:plan.group.lines.length,overflowed:false,pushed:false,pushedDeltaPt:0,pushedRegions:[],pushReason:undefined,overflowInkOverlap:false,unchangedLineDriftPt:0,quality:{maxUnchangedLineStartXDriftPt:0,maxUnchangedLineBaselineDriftPt:0,overflowInkOverlap:false}};
  };
  for(const [node,plans]of planned)try{
   const writable=plans.filter(p=>p.plan.blocks.length);
   const manifests=writable.length?await writeRetypeset(node.page,node.bytes,node.ops,node.read,writable.map(p=>p.plan),options,byNode.size>1?'multiple-stream-edits':accepted.size?'other-edited-content':undefined):[];
   if(writable.length)node.changed=true;
   let written=0;
   for(const p of plans){
    const manifest=p.plan.blocks.length?manifests[written++]!:idle(p.plan);
    const m=node.matrix,q=manifest.quality;
    const residualX=Math.abs(m[0]!)*q.maxUnchangedLineStartXDriftPt+Math.abs(m[2]!)*q.maxUnchangedLineBaselineDriftPt;
    const residualY=Math.abs(m[1]!)*q.maxUnchangedLineStartXDriftPt+Math.abs(m[3]!)*q.maxUnchangedLineBaselineDriftPt;
    results.push({edits:p.edits,manifest:{...manifest,paragraphBox:formPageBox(node.matrix,manifest.paragraphBox),
     pushedDeltaPt:manifest.pushedDeltaPt*Math.hypot(node.matrix[2]!,node.matrix[3]!),
     unchangedLineDriftPt:Math.max(residualX,residualY,Math.abs(m[2]!)*manifest.pushedDeltaPt,Math.abs(m[3]!)*manifest.pushedDeltaPt),
     quality:{...q,maxUnchangedLineStartXDriftPt:residualX,maxUnchangedLineBaselineDriftPt:residualY},
     pushedRegions:manifest.pushedRegions.map(r=>({before:formPageBox(node.matrix,r.before),after:formPageBox(node.matrix,r.after)}))}});
   }
  }catch(error){for(const p of plans)for(const e of p.edits)refuse(e.overlay,'unsupported-unwritable',String(error));}
  if(!results.length)return;
  if(retypesetFormStamp(page)!==stamp)throw Error('page or Form resources changed during retypeset preparation');
  installRetypesetForms(page,tree.root);
  for(const {edits,manifest}of results)for(const e of edits){accepted.add(e.overlay.id);outcomes.set(e.overlay.id,{overlayId:e.overlay.id,mode:'retypeset',fidelity:'approximate',retypeset:{...manifest,reason:e.reason}});}
 }catch(error){for(const e of pending)if(!accepted.has(e.id))refuse(e,'unsupported-unwritable',String(error));}
}
