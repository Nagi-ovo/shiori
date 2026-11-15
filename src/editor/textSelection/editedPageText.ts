import type {PdfDocument,PdfPageText,PdfEngine} from '../../pdf/engine/types';
import {appPdfEngine} from '../../pdf/engine/appEngine';
import type {ContentTextOverlay,PageModel} from '../../pdf/model/types';
import {buildContentTextPreview} from '../components/contentTextPreview';
const textByBytes=new WeakMap<Uint8Array,Promise<PdfPageText>>();
/** Shared reading source for DOM selection/copy and Find. The source editing
 * gesture can explicitly retain original geometry for re-edit/absorption. */
export async function readEditedPageText(doc:PdfDocument,page:PageModel,bytes:Uint8Array|null|undefined,overlays:readonly ContentTextOverlay[],options:Parameters<PdfEngine['pageText']>[2]={}):Promise<PdfPageText>{
 options?.checkAbort?.();
 if(!bytes || !overlays.length)return appPdfEngine.pageText(doc,page.sourceIndex,options);
 const preview=await buildContentTextPreview(bytes,page,overlays);options?.checkAbort?.();
 if(!preview.bytes)return appPdfEngine.pageText(doc,page.sourceIndex,options);
 let pending=textByBytes.get(preview.bytes);
 if(!pending){const edited=preview.bytes;pending=(async()=>{const loaded=await appPdfEngine.load(edited,{});try{return await appPdfEngine.pageText(loaded.doc,0);}finally{await appPdfEngine.destroy(loaded.doc);}})().catch(error=>{textByBytes.delete(edited);throw error;});textByBytes.set(edited,pending);}
 const result=await pending;options?.checkAbort?.();return result;
}
