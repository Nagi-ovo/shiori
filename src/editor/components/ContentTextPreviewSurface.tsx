import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ContentTextOverlay, PageModel } from '../../pdf/model/types';
import { appPdfEngine } from '../../pdf/engine/appEngine';
import type { PdfDocument } from '../../pdf/engine/types';
import { rotatedSize } from '../../pdf/geometry/coords';
import { MAX_CANVAS_PIXELS } from '../../pdf/openPolicy';
import { buildContentTextPreview, contentTextPreviewKey } from './contentTextPreview';
import { ContentTextPreviewContext, emptyContentTextPreview, type ContentTextPreviewState } from './contentTextPreviewContext';
export function ContentTextPreviewSurface({bytes,page,overlays,scale,children}:{bytes:Uint8Array;page:PageModel;overlays:readonly ContentTextOverlay[];scale:number;children:ReactNode}) {
 const canvas=useRef<HTMLCanvasElement>(null);
 const key=useMemo(()=>contentTextPreviewKey(bytes,page,overlays),[bytes,page,overlays]);
 const request=`${key}|${scale}`;
 const source=useMemo(()=>contentTextPreviewKey(bytes,page,[]),[bytes,page]);
 const [state,setState]=useState<{request:string;source:string;value:ContentTextPreviewState;ready:boolean}|null>(null);
 useEffect(()=>{
  if(!overlays.length)return;
  let cancelled=false,task:ReturnType<typeof appPdfEngine.renderRegion>|undefined;
  const timer=setTimeout(()=>{void(async()=>{
   let doc:PdfDocument|undefined;
   try{
    const preview=await buildContentTextPreview(bytes,page,overlays);
    if(cancelled)return;
    const accepted=new Set(preview.outcomes.filter(o=>o.mode!=='overlay').map(o=>o.overlayId));
    if(!preview.bytes){setState({request,source,value:{accepted,outcomes:preview.outcomes},ready:false});return;}
    const loaded=await appPdfEngine.load(preview.bytes,{});doc=loaded.doc;
    if(cancelled)return;
    const size=rotatedSize(page.widthPt,page.heightPt,page.rotation);
    const dpr=Math.min(window.devicePixelRatio||1,Math.sqrt(MAX_CANVAS_PIXELS/(size.width*size.height*scale*scale)));
    const width=Math.max(1,Math.ceil(size.width*scale*dpr)),height=Math.max(1,Math.ceil(size.height*scale*dpr));
    const target=document.createElement('canvas');target.width=width;target.height=height;
    task=appPdfEngine.renderRegion(doc,{sourceIndex:0,rotation:page.rotation,scale,dpr,region:{x:0,y:0,width,height}},target);
    await task.done;if(cancelled)return;
    const visible=canvas.current,context=visible?.getContext('2d');
    if(!visible || !context)throw Error('preview canvas unavailable');
    visible.width=width;visible.height=height;context.drawImage(target,0,0);target.width=0;target.height=0;
    setState({request,source,value:{accepted,rasterized:new Set(overlays.map(o=>o.id)),outcomes:preview.outcomes},ready:true});
   }catch{
    if(!cancelled)setState({request,source,value:{accepted:new Set(),outcomes:overlays.map(o=>({overlayId:o.id,mode:'overlay',reason:'preview-unavailable'}))},ready:false});
   }finally{if(doc)await appPdfEngine.destroy(doc);}
  })();},220);
  return()=>{cancelled=true;clearTimeout(timer);task?.cancel();};
 },[bytes,page,overlays,scale,request,source]);
 const current=state?.source===source?state:null;
 return <ContentTextPreviewContext value={current?.value??emptyContentTextPreview}>
  <canvas ref={canvas} aria-hidden="true" data-content-text-preview="true" style={{position:'absolute',inset:0,width:'100%',height:'100%',pointerEvents:'none',zIndex:2,visibility:current?.ready?'visible':'hidden'}}/>
  {children}
 </ContentTextPreviewContext>;
}
