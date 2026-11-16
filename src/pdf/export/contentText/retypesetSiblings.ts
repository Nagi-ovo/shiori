import type {PDFPage} from 'pdf-lib';
import type {ContentTextOverlay} from '../../model/types';
import type {ContentOp} from '../contentStreamEdit/tokenizer';
import type {Type1Options} from '../fontCoverage/type1Support';
import type {PageRunPlan} from '../contentStreamEdit/pageRunPlan';
import type {ContentTextOutcome} from './outcomes';
import {readRetypesetSource,paragraphGroups,address} from './retypesetSource';
import {selectRetypeset} from './retypesetPlan';
/** A paragraph cannot carry an exact label for one edit while approximate
 * layout moves it for another. Defer siblings before any stream installation;
 * all changes in that paragraph will be composed from one source revision. */
export function deferRetypesetSiblings(page:PDFPage,ops:ContentOp[],edits:readonly ContentTextOverlay[],plans:Map<string,PageRunPlan>,outcomes:Map<string,ContentTextOutcome>,options?:Type1Options){
 const deferred=new Set<string>();if(edits.length<2||plans.size===edits.length)return deferred;
 try{
  const source=readRetypesetSource(page,ops,options);if(!source.walk.ok)return deferred;
  const groups=new Map<string,string[]>();
  for(const e of edits){
   const selected=selectRetypeset(source.glyphs,e);if(!selected.length)continue;
   const group=paragraphGroups(source.glyphs,ops,selected[0]!).group;
   if(!group)continue;
   const key=group.lines.flatMap(l=>l.glyphs.map(g=>address(g.glyph))).join('|'),members=groups.get(key)??[];
   members.push(e.id);groups.set(key,members);
  }
  for(const ids of groups.values())if(ids.length>1&&ids.some(id=>!plans.has(id)))for(const id of ids){
   deferred.add(id);
   if(plans.delete(id))outcomes.set(id,{overlayId:id,mode:'unsupported',reason:'shared-text-object'});
  }
 }catch{ /* Unmeasurable paragraphs remain independent exact refusals. */ }
 return deferred;
}
