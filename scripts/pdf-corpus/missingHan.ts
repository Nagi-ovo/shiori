import type {ContentTextOverlay} from '../../src/pdf/model/types';
import type {ResolvedRunFont} from '../../src/pdf/export/contentStreamEdit/replaceRun';
import {planContentText} from '../../src/pdf/export/contentText/planner';
import type {CorpusEdit} from './editMatrix';
/** The source resolver, never page usage, proves the missing Han cluster.
 * These common scalars are in the bundled SC face; prepareFallback still
 * verifies its actual emitted subset before accepting the export. */
export function missingHanEdit(content:Uint8Array,fonts:readonly ResolvedRunFont[],overlay:ContentTextOverlay):(CorpusEdit&{missingHan:string})|null {
 let offset=0;
 for(const original of overlay.originalText){
  if(/\p{Script=Han}/u.test(original))for(const missingHan of ['测','试','新','汉','字','栞']){
   if(missingHan===original)continue;
   const text=overlay.originalText.slice(0,offset)+missingHan+overlay.originalText.slice(offset+original.length);
   const planned=planContentText(content,fonts,{...overlay,text});
   if(!planned.ok || planned.plan.edits.length!==1)continue;
   const edit=planned.plan.edits[0]!,font=fonts.find(f=>f.resourceName===edit.fontResource && f.objectId===edit.fontObject);
   if(font?.canEncode && !font.canEncode(missingHan).ok)return{kind:'missing-han',text,missingHan};
  }
  offset+=original.length;
 }
 return null;
}
