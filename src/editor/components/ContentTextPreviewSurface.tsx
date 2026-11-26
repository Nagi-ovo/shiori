import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PageModel, SourceImageEditOverlay, TextFlowChain } from '../../pdf/model/types';
import { appPdfEngine } from '../../pdf/engine/appEngine';
import type { PdfDocument } from '../../pdf/engine/types';
import { pdfRectToDisplay, rotatedSize } from '../../pdf/geometry/coords';
import { compositePdfPaperColor } from '../../design/pdfPaperTone';
import { MAX_CANVAS_PIXELS } from '../../pdf/openPolicy';
import type { AcceptanceVerdict } from '../../pdf/export/acceptance';
import type { ContentTextOutcome } from '../../pdf/export/contentText/outcomes';
import { contentTextPreviewKey, prepareContentTextPreview, type ContentTextPreviewOptions, type PageContentEdit } from './contentTextPreview';
import { ContentTextPreviewContext, contentTextExclusion, emptyContentTextPreview, type ContentTextPreviewState } from './contentTextPreviewContext';

type PreviewRequest=ReturnType<typeof prepareContentTextPreview>;
type Frame={preview:PreviewRequest|null;page:PageModel;overlays:readonly PageContentEdit[];editingId:string|null;scale:number;paperColor:string|null};
type Shown={source:string;frame:Frame;value:ContentTextPreviewState;ready:boolean;bitmap?:HTMLCanvasElement};

// The page as the writer would save it, drawn over the source page. The edit
// being typed into is drawn with its source glyphs excluded and nothing in
// their place: its textarea paints the live text, so keystrokes never wait for
// (or race) a rebuild, and no cover hides the artwork under the glyphs.
export function ContentTextPreviewSurface({bytes,sourceDoc,page,overlays,scale,editingId=null,previewOptions,flowChains,paperColor=null,children}:{bytes:Uint8Array;sourceDoc?:PdfDocument;page:PageModel;overlays:readonly PageContentEdit[];scale:number;editingId?:string|null;previewOptions?:ContentTextPreviewOptions;flowChains?:readonly TextFlowChain[];paperColor?:string|null;children:ReactNode}) {
 const canvas=useRef<HTMLCanvasElement>(null),painted=useRef<HTMLCanvasElement|null>(null);
 const editing=editingId!==null && overlays.some(o=>o.type==='contentText' && o.id===editingId)?editingId:null;
 const frameOverlays=useMemo(()=>overlays.map(o=>o.type==='contentText' && o.id===editing?contentTextExclusion(o):o),[overlays,editing]);
 const hasEdits=overlays.length>0;
 const hasImageEdits=overlays.some(o=>o.type==='sourceImageEdit');
 const options=useMemo(()=>flowChains?{...previewOptions,flowChains}:previewOptions,[previewOptions,flowChains]);
 const framePreview=hasEdits?prepareContentTextPreview(bytes,page,frameOverlays,sourceDoc,options):null;
 // Held by request, so typing (which leaves the request unchanged) starts nothing.
 const [frame,setFrame]=useState<Frame>({preview:framePreview,page,overlays:frameOverlays,editingId:editing,scale,paperColor});
 if(frame.preview?.key!==framePreview?.key || frame.scale!==scale || frame.editingId!==editing || frame.paperColor!==paperColor) {
  setFrame({preview:framePreview,page,overlays:frameOverlays,editingId:editing,scale,paperColor});
 }
 const source=useMemo(()=>hasEdits?contentTextPreviewKey(bytes,page,[],sourceDoc,options):null,[bytes,hasEdits,page,sourceDoc,options]);
 const [state,setState]=useState<Shown|null>(null);
 if(state && state.source!==source)setState(null);
 useEffect(()=>{
  const {page,scale,overlays:list,preview:request}=frame;
  if(!request || !source)return;
  const draft=list.find(o=>o.id===frame.editingId);
  const draftKey=draft && JSON.stringify(draft);
  const exclusionRefusal=(outcomes:readonly ContentTextOutcome[]):ContentTextPreviewState['exclusionRefusal']=>{
   const failure=outcomes.find(o=>o.overlayId===frame.editingId && o.mode==='unsupported');
   return failure && draftKey ? {id:failure.overlayId,key:draftKey,reason:failure.reason??'unsupported-unwritable'}:undefined;
  };
  let cancelled=false,task:ReturnType<typeof appPdfEngine.renderRegion>|undefined;
  const unsupported=(reason:ContentTextOutcome['reason']):ContentTextOutcome[]=>list.flatMap(o=>o.type==='contentText'?[{overlayId:o.id,mode:'unsupported',reason}]:[]);
  const timer=setTimeout(()=>{void(async()=>{
   let doc:PdfDocument|undefined,acceptance:AcceptanceVerdict|undefined;
   try{
    const preview=await request.build();
    if(cancelled)return;
    acceptance=preview.acceptance;
    const accepted=new Set(preview.outcomes.filter(o=>o.mode!=='unsupported').map(o=>o.overlayId));
    const appliedImages=new Set(preview.imageOutcomes?.filter(o=>o.mode==='applied').map(o=>o.overlayId));
    const imageEdits=list.filter((o): o is SourceImageEditOverlay=>o.type==='sourceImageEdit' && appliedImages.has(o.id));
    const imageFailed=preview.imageOutcomes?.some(o=>o.mode==='unsupported');
    const result={accepted,exclusionRefusal:exclusionRefusal(preview.outcomes),outcomes:preview.outcomes,acceptance,imageEdits,imageFailed};
    // Resolved refusals show the source page with no cover.
    if(!preview.bytes){setState({source,frame,value:result,ready:false});return;}
    const loaded=await appPdfEngine.load(preview.bytes,{});doc=loaded.doc;
    if(cancelled)return;
    const size=rotatedSize(page.widthPt,page.heightPt,page.rotation);
    const dpr=Math.min(window.devicePixelRatio||1,Math.sqrt(MAX_CANVAS_PIXELS/(size.width*size.height*scale*scale)));
    const width=Math.max(1,Math.ceil(size.width*scale*dpr)),height=Math.max(1,Math.ceil(size.height*scale*dpr));
    const bitmap=document.createElement('canvas');bitmap.width=width;bitmap.height=height;
    task=appPdfEngine.renderRegion(doc,{sourceIndex:preview.pageIndex??0,rotation:page.rotation,scale,dpr,region:{x:0,y:0,width,height}},bitmap);
    await task.done;if(cancelled)return;
    const ctx=bitmap.getContext('2d');
    if(ctx)compositePdfPaperColor(ctx,width,height,frame.paperColor);
    const excluded=draft && draftKey && accepted.has(draft.id)?new Map([[draft.id,draftKey]]):undefined;
    setState({source,frame,value:{...result,excluded},ready:true,bitmap});
   }catch{
    const outcomes=unsupported('preview-unavailable');
    if(!cancelled)setState({source,frame,value:{accepted:new Set(),exclusionRefusal:exclusionRefusal(outcomes),outcomes,acceptance,imageFailed:list.some(o=>o.type==='sourceImageEdit')},ready:false});
   }finally{if(doc)await appPdfEngine.destroy(doc);}
  })();},0);
  return()=>{cancelled=true;clearTimeout(timer);task?.cancel();};
 },[source,frame]);
 // Paint the frame in the same commit that tells the DOM which glyphs it now
 // carries, so neither a double print nor a missing word reaches the screen.
 useLayoutEffect(()=>{
  const bitmap=state?.bitmap,visible=canvas.current;
  if(!bitmap || !visible){painted.current=null;return;}
  if(painted.current===bitmap)return;
  painted.current=bitmap;
  visible.width=bitmap.width;visible.height=bitmap.height;visible.getContext('2d')?.drawImage(bitmap,0,0);
 },[state]);
 const draftPreview=editing===null?null:prepareContentTextPreview(bytes,page,overlays,sourceDoc,options);
 const live=useLivePreview(editing,draftPreview);
 const current=source!==null && state?.source===source?state:null,base=current?.value??emptyContentTextPreview;
 const frameIsCurrent=current!==null && current.frame.preview?.key===framePreview?.key && current.frame.editingId===editing;
 const value=useMemo(()=>{
  const outcomes=frameIsCurrent?base.outcomes.filter(o=>o.overlayId!==editing):[];
  if(live)outcomes.push(live.outcome);
  return {
   ...base,
   imageFailed:frameIsCurrent && base.imageFailed,
   imagePending:!frameIsCurrent && (hasImageEdits || !!base.imageEdits?.length),
   outcomes,
   acceptance:editing===null?(frameIsCurrent?base.acceptance:undefined):live?.acceptance,
   exclusionRefusal:frameIsCurrent?base.exclusionRefusal:undefined,
   pending:editing!==null && !live,
  };
 },[base,editing,frameIsCurrent,hasImageEdits,live]);
 const regions=value.acceptance?.findings.flatMap(({kind,overlayId,region})=>region?[{key:`${kind}:${overlayId}`,region}]:[])??[];
 return <ContentTextPreviewContext value={value}>
  {hasEdits && <canvas ref={canvas} aria-hidden="true" data-content-text-preview="true" style={{position:'absolute',inset:0,width:'100%',height:'100%',pointerEvents:'none',zIndex:2,visibility:current?.ready?'visible':'hidden'}}/>}
  {regions.length>0 && <svg aria-hidden="true" data-content-text-contact-region=""
    style={{position:'absolute',inset:0,width:'100%',height:'100%',pointerEvents:'none',zIndex:12}}>
   {regions.map(({key,region})=>{
    const r=pdfRectToDisplay(region,page.widthPt,page.heightPt,page.rotation,scale);
    return <rect key={key} x={r.x-2} y={r.y-2} width={r.w+4} height={r.h+4}
      fill="rgba(218, 104, 18, 0.18)" stroke="#bd5011" strokeWidth={2} />;
   })}
  </svg>}
  {children}
 </ContentTextPreviewContext>;
}

const LIVE_OUTCOME_DELAY_MS=220;
type LiveResult={outcome:ContentTextOutcome;acceptance?:AcceptanceVerdict};
type LiveDraft={
  preview:PreviewRequest;
  overlayId:string;
  result?:LiveResult;
};

// The writer receives the actual draft. A new request clears the previous
// result immediately, including when the same overlay is reopened.
function useLivePreview(editing:string|null,preview:PreviewRequest|null) {
  const [draft,setDraft]=useState<LiveDraft|null>(null);
  const current=draft?.preview.key===preview?.key && draft?.overlayId===editing?draft:null;
  if(preview && editing!==null && !current) {
    setDraft({preview,overlayId:editing});
  }else if(editing===null && draft) {
    setDraft(null);
  }
  useEffect(()=>{
    if(!draft || draft.result)return;
    let cancelled=false;
    const unavailable:ContentTextOutcome={overlayId:draft.overlayId,mode:'unsupported',reason:'preview-unavailable'};
    const finish=(result:LiveResult)=>{
      if(!cancelled)setDraft(active=>active===draft?{...draft,result}:active);
    };
    const timer=setTimeout(()=>{
      void draft.preview.build().then(
        preview=>finish({
          outcome:preview.outcomes.find(outcome=>outcome.overlayId===draft.overlayId)??unavailable,
          acceptance:preview.acceptance,
        }),
        ()=>finish({outcome:unavailable}),
      );
    },LIVE_OUTCOME_DELAY_MS);
    return()=>{cancelled=true;clearTimeout(timer);};
  },[draft]);
  return current?.result;
}
