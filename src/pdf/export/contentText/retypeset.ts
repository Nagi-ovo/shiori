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
  for(const [node,plans]of planned)try{
   const manifests=await writeRetypeset(node.page,node.bytes,node.ops,node.read,plans.map(p=>p.plan),options);node.changed=true;
   plans.forEach((p,i)=>results.push({edits:p.edits,manifest:{...manifests[i]!,paragraphBox:formPageBox(node.matrix,manifests[i]!.paragraphBox)}}));
  }catch(error){for(const p of plans)for(const e of p.edits)refuse(e.overlay,'unsupported-unwritable',String(error));}
  if(!results.length)return;
  if(retypesetFormStamp(page)!==stamp)throw Error('page or Form resources changed during retypeset preparation');
  installRetypesetForms(page,tree.root);
  for(const {edits,manifest}of results)for(const e of edits){accepted.add(e.overlay.id);outcomes.set(e.overlay.id,{overlayId:e.overlay.id,mode:'retypeset',fidelity:'approximate',retypeset:{...manifest,reason:e.reason}});}
 }catch(error){for(const e of pending)if(!accepted.has(e.id))refuse(e,'unsupported-unwritable',String(error));}
}
