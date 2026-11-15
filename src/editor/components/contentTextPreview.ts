import { PDFDocument } from 'pdf-lib';
import type { ContentTextOverlay, PageModel } from '../../pdf/model/types';
import { isBlankPage } from '../../pdf/model/types';
import {rebuildPdf} from '../../pdf/export/rebuildPdf';
import {cjkScExportFontUrl,cjkJpExportFontUrl} from '../../pdf/export/fontAssets';
import type { ContentTextOutcome } from '../../pdf/export/contentText/outcomes';
import { sourceFingerprint } from '../../pdf/export/contentStreamEdit/replaceRun';
export type ContentTextPreview = { bytes: Uint8Array|null; outcomes:ContentTextOutcome[] };
const hashes=new WeakMap<Uint8Array,string>();
const cache=new Map<string,Promise<ContentTextPreview>>();
export function contentTextPreviewKey(bytes:Uint8Array,page:PageModel,overlays:readonly ContentTextOverlay[]) {
 let hash=hashes.get(bytes);if(!hash){hash=sourceFingerprint(bytes);hashes.set(bytes,hash);}
 return JSON.stringify([hash,page,overlays]);
}
export function buildContentTextPreview(bytes:Uint8Array,page:PageModel,overlays:readonly ContentTextOverlay[]):Promise<ContentTextPreview> {
 const key=contentTextPreviewKey(bytes,page,overlays),existing=cache.get(key);
 if(existing)return existing;
 const work=(async()=>{
  if(!overlays.length || isBlankPage(page))return{bytes:null,outcomes:[]};
  const source=await PDFDocument.load(bytes,{ignoreEncryption:true});
  if(source.isEncrypted)throw Error('encrypted preview unavailable');
  const result=await rebuildPdf(bytes,{pages:[page],overlays:[...overlays]}, {mode:'flatten',unicodeFontUrl:cjkScExportFontUrl,unicodeJpFontUrl:cjkJpExportFontUrl});
  const outcomes=result.contentTextOutcomes??[];
  return{bytes:outcomes.some(o=>o.mode!=='overlay')?result.bytes:null,outcomes};
 })().catch(error=>{cache.delete(key);throw error;});
 cache.set(key,work);while(cache.size>8)cache.delete(cache.keys().next().value!);
 return work;
}
