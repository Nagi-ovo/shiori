import {useEffect,useMemo,useState} from 'react';
import type {PdfDocument,PdfPageText} from '../../pdf/engine/types';
import type {PageModel} from '../../pdf/model/types';
import {appPdfEngine} from '../../pdf/engine/appEngine';
import {textContentToDisplayTextRuns,type DisplayRect,type TextRunDisplayBounds} from './highlightRects';
import {detectParagraphs} from './paragraphDetect';
import {mapTextContentGlyphs} from './glyphGeometry';
import {glyphDisplayRect} from './markupSelection';
/** Source addresses belong only to new-overlay creation. Reading/copy and
 * visible selection use the separate edited-page reader. */
export function useContentTextSourceGeometry(doc:PdfDocument,page:PageModel,enabled:boolean,scale:number){
 const [loaded,setLoaded]=useState<{doc:PdfDocument;page:PageModel;text:PdfPageText}|null>(null);
 useEffect(()=>{
  if(!enabled)return;
  let cancelled=false;
  void appPdfEngine.pageText(doc,page.sourceIndex,{checkAbort:()=>{if(cancelled)throw Error('source geometry cancelled');}})
   .then(text=>{if(!cancelled)setLoaded({doc,page,text});}).catch(()=>{/* No source proof means no new source edit. */});
  return()=>{cancelled=true;};
 },[doc,page,enabled]);
 return useMemo(()=>{
  if(!enabled || loaded?.doc!==doc || loaded.page!==page)return null;
  const text=loaded.text,runs=textContentToDisplayTextRuns(text.content,page,scale,text.fontNames);
  const glyphs=text.glyphs?mapTextContentGlyphs(text.content,text.glyphs):null;
  const entries=runs.flatMap((run,index)=>{
   if(!run || !run.text.length)return[];
   const offsetXs=Array.from({length:run.text.length+1},(_,i)=>run.x+run.w*i/run.text.length);
   for(const glyph of glyphs?.[index]??[]){const rect=glyphDisplayRect(glyph,page,scale);offsetXs[glyph.start]=rect.x;offsetXs[glyph.endOffset]=rect.x+rect.w;}
   return[{run,text:run.text,startOffset:0,endOffset:run.text.length,offsetXs,selectionSource:'gesture' as const}];
  });
  return{paragraphs:detectParagraphs(runs.filter((r):r is TextRunDisplayBounds=>r!==null),scale),
   select:(rects:readonly DisplayRect[])=>entries.filter(({run})=>rects.some(r=>r.x<run.x+run.w && r.x+r.w>run.x && r.y<run.y+run.h && r.y+r.h>run.y))};
 },[doc,page,enabled,scale,loaded]);
}
