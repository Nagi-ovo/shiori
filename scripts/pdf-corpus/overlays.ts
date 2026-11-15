import type {openPdfium} from '../pdf-inplace/nativePdfium';
import type {ContentTextOverlay,PageModel} from '../../src/pdf/model/types';
import type {TextRunDisplayBounds} from '../../src/editor/textSelection/highlightRects';
import {deterministicTextVerticalMetrics} from '../../src/pdf/geometry/textMetrics';
import {detectParagraphs,paragraphLineText} from '../../src/editor/textSelection/paragraphDetect';
import {displayRectsToPdfRects} from '../../src/editor/textSelection/highlightRects';
import {contentTextEditRect,expandPdfRectSides,sourceBaselinesFromRuns,inferContentTextStyle} from '../../src/editor/components/textHighlightGeometry';
type NativePage=ReturnType<ReturnType<typeof openPdfium>['inspectPage']>;
/** Native ABI glyphs are grouped by text object/baseline; everything after
 * this adapter is the real UI paragraph/cover/baseline/style builder. The ABI
 * supplies tight ink boxes rather than the app's advance/ink union (documented
 * corpus shortcut). No source placement or compiler geometry creates covers. */
export function buildCorpusOverlays(native:NativePage,page:PageModel):ContentTextOverlay[]{
 const runs:TextRunDisplayBounds[]=[];
 let previous:NativePage['glyphs'][number]|undefined;
 for(const g of native.glyphs){
  if(!g.text || !g.fontSize || Math.abs(g.angle)>.02)continue;
  const [l,rawBottom,r,rawTop]=g.box;
  const metrics=deterministicTextVerticalMetrics(g.fontSize,{ascent:(rawTop-g.origin[1])/g.fontSize,descent:(rawBottom-g.origin[1])/g.fontSize});
  const b=g.origin[1]-metrics.descent,t=g.origin[1]+metrics.ascent;
  const baseline=page.heightPt-g.origin[1];
  const last=runs.at(-1);
  if(previous?.object===g.object && last && Math.abs((last.baselineY??0)-baseline)<.04*g.fontSize && g.origin[0]>=previous.origin[0]){
   const right=Math.max(last.x+last.w,r);const bottom=Math.max(last.y+last.h,page.heightPt-b);
   last.x=Math.min(last.x,l);last.y=Math.min(last.y,page.heightPt-t);last.w=right-last.x;last.h=bottom-last.y;last.text+=g.text;
  }else runs.push({x:l,y:page.heightPt-t,w:Math.max(0,r-l),h:Math.max(0,t-b),text:g.text,baselineY:baseline,fontSizePt:g.fontSize,dirAngleDeg:0});
  previous=g;
 }
 const blocks=detectParagraphs(runs,1).filter(p=>p.confidence==='high');
 const result:ContentTextOverlay[]=[];
 for(const block of blocks){
  const groups=block.lines.map(line=>[line]);
  if(block.lines.length>1)groups.push(block.lines.slice(0,2));
  for(const lines of groups){
   const originalText=lines.map(line=>paragraphLineText(line,1)).join('\n');if(originalText.trim().length<3)continue;
   const selected=lines.flatMap(l=>l.runs);
   const rects=displayRectsToPdfRects(lines.map(l=>({x:l.x,y:l.top,w:l.width,h:l.bottom-l.top})),page,1);
   if(!rects.length)continue;
   const style=inferContentTextStyle(selected,rects,{fontSize:12,color:'#000000',bold:false,italic:false,align:'left',fontFamily:'sans'});
   result.push({id:`line-${result.length}`,pageId:page.id,type:'contentText',originalText,text:originalText,
    rect:contentTextEditRect(rects,page),coverRects:rects.map(rect=>expandPdfRectSides(rect,{left:.8,right:.8,vertical:.8},page)),
    sourceBaselinesPt:sourceBaselinesFromRuns(selected,page,1)??undefined,...style,align:'left',color:'#000000',backgroundColor:'#ffffff',sourceStyle:{fontSize:style.fontSize,color:'#000000',bold:style.bold,italic:style.italic,align:'left',fontFamily:style.fontFamily,backgroundColor:'#ffffff'}});
  }
 }
 return result;
}
