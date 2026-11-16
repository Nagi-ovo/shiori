import type {PDFPage} from 'pdf-lib';
import type {ContentTextOverlay} from '../../model/types';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import type {SubstituteOptions} from '../contentStreamEdit/substitute';
import type {ContentTextOutcome} from './outcomes';
import {readRetypesetSource,pageXObjects,paragraphGroups} from './retypesetSource';
import {planRetypeset,selectRetypeset} from './retypesetPlan';
import {textFormNames,imageOverlaps,imageFormNames,formImageOverlaps} from './retypesetLayers';
import {writeRetypeset} from './retypesetWrite';
import type {RetypesetEdit} from './retypesetTypes';
import {addRetypesetBatch,type RetypesetBatch} from './retypesetBatches';
/** All outstanding edits in a paragraph share one layout and one transaction. */
export async function applyRetypesets(page:PDFPage,edits:readonly ContentTextOverlay[],outcomes:Map<string,ContentTextOutcome>,accepted:Set<string>,options:SubstituteOptions){
 const pending=edits.filter(e=>!accepted.has(e.id));if(!pending.length)return;
 const refuse=(e:ContentTextOverlay,reason:ContentTextOutcome['reason'],detail?:string)=>outcomes.set(e.id,{overlayId:e.id,mode:'unsupported',reason,detail});
 const source=inspectRunPage(page);if(!source.ok){for(const e of pending)refuse(e,'unsupported-unwritable',source.reason);return;}
 try{
  const ops=tokenizeContentStream(source.bytes),read=readRetypesetSource(page,ops,options.stage5Type1),objects=pageXObjects(page);
  const textForms=textFormNames(page),forms=ops.some(o=>o.operator==='Do'&&o.operands[0]?.kind==='name'&&textForms.has(o.operands[0].value));
  if(!read.walk.ok){for(const e of pending)refuse(e,'unsupported-unwritable',read.walk.reason);return;}
  const imageUses=[...read.walk.inlineImages,...read.walk.xobjects.filter(o=>objects.get(o.name)==='Image')];
  const imageForms=imageFormNames(page),formImages=read.walk.xobjects.filter(o=>imageForms.has(o.name));
  const batches:RetypesetBatch<RetypesetEdit>[]=[];
  for(const e of pending){
   if(outcomes.get(e.id)?.reason==='stale-source'){refuse(e,'unsupported-unwritable','stale source revision');continue;}
   const selected=selectRetypeset(read.glyphs,e);
   if(!selected.length){refuse(e,forms?'unsupported-form-xobject':!read.glyphs.length?'unsupported-no-text-layer':'unsupported-unwritable','no walkable glyphs at selection');continue;}
   const imageBehind=imageUses.some(o=>imageOverlaps(o.ctm,e.coverRects))||formImages.some(o=>formImageOverlaps(page,o.name,o.ctm,e.coverRects));
   if(imageBehind&&selected.some(g=>g.state.renderMode===3)){refuse(e,'unsupported-image-text');continue;}
   const frame=paragraphGroups(read.glyphs,ops,selected[0]!,selected);
   if(!frame.group)throw Error('no paragraph at selection');
   addRetypesetBatch(batches,frame.group,{overlay:e,selected,reason:outcomes.get(e.id)?.reason??'unsupported-state'});
  }
  // Build all paragraphs from the same immutable revision. No partial write
  // when a shared paragraph cannot be addressed safely.
  const planned:{edits:RetypesetEdit[];plan:ReturnType<typeof planRetypeset>}[]=[];
  for(const {members:batch}of batches)try{planned.push({edits:batch,plan:planRetypeset(read.glyphs,ops,batch)});}catch(error){for(const e of batch)refuse(e.overlay,'unsupported-unwritable',String(error));}
  if(!planned.length)return;
  try{
   const manifests=await writeRetypeset(page,source.bytes,ops,read,planned.map(p=>p.plan),options);
   planned.forEach((p,i)=>p.edits.forEach(e=>{accepted.add(e.overlay.id);outcomes.set(e.overlay.id,{overlayId:e.overlay.id,mode:'retypeset',fidelity:'approximate',retypeset:{...manifests[i]!,reason:e.reason}});}));
  }catch(error){for(const p of planned)for(const e of p.edits)refuse(e.overlay,'unsupported-unwritable',String(error));}
 }catch(error){for(const e of pending)if(!accepted.has(e.id))refuse(e,'unsupported-unwritable',String(error));}
}
