import {useEffect,useMemo,useState} from 'react';
import type {PdfDocument,PdfPageText} from '../../pdf/engine/types';
import type {PageModel,PdfRect} from '../../pdf/model/types';
import {appPdfEngine} from '../../pdf/engine/appEngine';
import {textContentToDisplayTextRuns,type DisplayRect,type TextRunDisplayBounds} from './highlightRects';
import {detectParagraphs,isMathFontName,type DetectedParagraph} from './paragraphDetect';
import {mapTextContentGlyphs} from './glyphGeometry';
import {glyphDisplayRect} from './markupSelection';
import {pdfToDisplay} from '../../pdf/geometry/coords';
import {observeSourceGlyphs} from '../../pdf/model/sourceGlyphs';
import {pageOrigin,pdfPointToPageLocal} from '../../pdf/model/pageSpace';
import type {CaretCell} from './contentTextCaret';
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
  // Engine glyph cells per run, for the caret a click opens an edit with.
  const cells=new WeakMap<TextRunDisplayBounds,CaretCell[]>();
  const display=(p:{x:number;y:number})=>pdfToDisplay(pdfPointToPageLocal(page,p),page.widthPt,page.heightPt,page.rotation,scale);
  runs.forEach((run,index)=>{if(run)cells.set(run,(glyphs?.[index]??[]).map(g=>({start:g.start,end:g.endOffset,rect:glyphDisplayRect(g,page,scale),from:display(g.origin),to:display(g.end),rtl:g.nativeCaret===true})));});
  const observe=(covers:readonly PdfRect[],size:number)=>observeSourceGlyphs(text.glyphs,covers,size,pageOrigin(page));
  const fieldAtPoint=(point:{x:number;y:number}):Pick<DetectedParagraph,'lines'>|undefined=>{
   const hits=runs.filter((run):run is TextRunDisplayBounds=>!!run && (cells.get(run)??[]).some(({rect})=>
    point.x>=rect.x && point.x<rect.x+rect.w && point.y>=rect.y && point.y<rect.y+rect.h));
   if(hits.length!==1)return;
   const run=hits[0]!,runCells=cells.get(run)!;
   if(runCells.length<2 || runCells[0]!.start!==0 || runCells.at(-1)!.end!==run.text.length ||
      runCells.some((cell,index)=>cell.rtl||cell.from.x>=cell.to.x||Math.abs(cell.from.y-cell.to.y)>.01||
       index>0&&(cell.start!==runCells[index-1]!.end||Math.abs(cell.from.x-runCells[index-1]!.to.x)>run.h*.2)) ||
      run.baselineY===undefined || !run.fontSizePt || isMathFontName(run.fontName))return;
   return {lines:[{runs:[run],x:run.x,right:run.x+run.w,width:run.w,top:run.y,bottom:run.y+run.h,
    baselineY:run.baselineY,fontSizePt:run.fontSizePt}]};
  };
  return{observe,fieldAtPoint,caretCells:(run:TextRunDisplayBounds):readonly CaretCell[]=>cells.get(run)??[],
   paragraphs:detectParagraphs(runs.filter((r):r is TextRunDisplayBounds=>r!==null),scale),
   select:(rects:readonly DisplayRect[])=>entries.filter(({run})=>rects.some(r=>r.x<run.x+run.w && r.x+r.w>run.x && r.y<run.y+run.h && r.y+r.h>run.y))};
 },[doc,page,enabled,scale,loaded]);
}
