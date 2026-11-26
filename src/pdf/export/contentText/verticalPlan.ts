import type {ContentTextOverlay,PdfRect} from '../../model/types';
import type {readVerticalSource,VerticalGlyph} from './verticalSource';
import {verticalGlyphInk,verticalAddress} from './verticalSource';
import type {VerticalFont} from './verticalFont';
import {simpleVerticalText} from './verticalFallback';
import {tateChuYokoRun} from './uprightColumnGlyphs';
import {contains,intersects} from './regionProof/geometry';
import type {ShowTextState} from '../contentStreamEdit/textState';

export type VerticalAtom={text:string;code:number;font:VerticalFont;home:VerticalGlyph;pen:{x:number;y:number};box:PdfRect};
export const joinedVertical=(text:string)=>text.replace(/\s/gu,'').normalize('NFC');
export function verticalScale(s:ShowTextState){
 const m=s.textMatrix!,c=s.ctm!;
 const a=m[0]!*c[0]!+m[1]!*c[2]!,b=m[0]!*c[1]!+m[1]!*c[3]!,cc=m[2]!*c[0]!+m[3]!*c[2]!,d=m[2]!*c[1]!+m[3]!*c[3]!;
 if(!(a>0&&d>0)||Math.abs(b)>1e-8||Math.abs(cc)>1e-8||!(s.horizontalScale!>0)||s.renderMode!==0)throw Error('vertical-orientation: requires upright fill text with a positive axis-aligned frame');
 return{x:a,y:d};
}
/** Contiguous selected spans alone enter layout. Source column geometry
 * determines capacity; unselected prefixes and suffixes keep their positions.
 * Column capacity and pitch come from observed pen positions, never ink width. */
export function planVertical(source:ReturnType<typeof readVerticalSource>,edit:ContentTextOverlay){
 const hits=source.glyphs.filter(g=>g.box&&edit.coverRects.some(r=>intersects(g.box!,r)));
 if(!hits.length)return;
 if(!source.walk.ok||source.walk.unplacedText)throw Error(`vertical-source: ${source.unplaced.join('; ')||'unplaced source text'}`);
 verticalScale(hits[0]!.state);
 if(hits.some(g=>!g.text||!g.box||!edit.coverRects.some(r=>contains(r,g.box!))))throw Error('vertical-source: partially covered or unlabelled glyph');
 const first=hits[0]!,scale=verticalScale(first.state),s=first.state;
 if(!edit.sourceStyle||(['fontSize','color','bold','italic','align','fontFamily','backgroundColor']as const).some(k=>edit[k]!==edit.sourceStyle![k]))throw Error('vertical-style: style changes require separate metric and paint proof');
 const same=(g:VerticalGlyph)=>g.font===first.font&&['fontSize','charSpacing','wordSpacing','horizontalScale','rise','renderMode'].every(k=>g.state[k as keyof ShowTextState]===s[k as keyof ShowTextState])&&g.state.textMatrix!.slice(0,4).every((v,i)=>v===s.textMatrix![i])&&g.state.ctm!.every((v,i)=>v===s.ctm![i]);
 if(hits.some(g=>!same(g)))throw Error('vertical-orientation: mixed writing frames or compact horizontal text');
 const hitSet=new Set(hits),columns:VerticalGlyph[][]=[];
 for(const g of source.glyphs.filter(same).sort((a,b)=>b.glyph.pen!.x-a.glyph.pen!.x||b.glyph.pen!.y-a.glyph.pen!.y)){
  const column=columns.find(c=>Math.abs(c[0]!.glyph.pen!.x-g.glyph.pen!.x)<.01);
  if(column)column.push(g);else columns.push([g]);
 }
 const affected=columns.filter(c=>c.some(g=>hitSet.has(g))),selected=affected.flatMap(c=>c.filter(g=>hitSet.has(g)));
 if(joinedVertical(selected.map(g=>g.text).join(''))!==joinedVertical(edit.originalText))throw Error('vertical-source: original label mismatch');
 const run=tateChuYokoRun(edit.text);
 if(run)throw Error(`vertical-glyph: ${JSON.stringify(run)} is a tate-chu-yoko run; no horizontal-in-vertical cell proof`);
 // A scalar outside upright CJK keeps the source's own vertical form only
 // when the source font already shows that exact code in a vertical column.
 // Scalars the font cannot encode are decided by the substitute's own gate.
 for(const c of new Set(Array.from(edit.text.replace(/\s/gu,'').normalize('NFC')))){
  const code=first.font.encode(c);if(!code||simpleVerticalText(c))continue;
  if(code.length!==2||!source.glyphs.some(g=>g.font===first.font&&g.text===c&&g.glyph.code===code[0]!*256+code[1]!))throw Error(`vertical-glyph: ${JSON.stringify(c)} has no observed vertical form in the source font`);
 }
 const columnGlyphs=affected.flat(),lo=columnGlyphs.findIndex(g=>hitSet.has(g)),hi=columnGlyphs.findLastIndex(g=>hitSet.has(g));
 if(columnGlyphs.slice(lo,hi+1).some(g=>!hitSet.has(g)))throw Error('vertical-source: discontiguous selection');
 const owned=columnGlyphs.slice(lo,hi+1);
 if(owned.some(g=>!g.box||!g.text))throw Error('vertical-source: unproved column ink or labels');
 for(const g of owned){
  const code=g.font.encode(g.text!);if(!code||code.length!==2||code[0]!*256+code[1]! !== g.glyph.code)throw Error('vertical-glyph: source code identity is unproved or ambiguous');
 }
 const text=oneColumnText(edit,affected.length);
 const pitch=columns.length>1?Math.min(...columns.slice(1).map((c,i)=>columns[i]![0]!.glyph.pen!.x-c[0]!.glyph.pen!.x)):s.fontSize*scale.x*1.2;
 if(!(pitch>=s.fontSize*scale.x*.8))throw Error('vertical-orientation: interleaved columns or compact horizontal text');
 const top=Math.max(...owned.map(g=>g.glyph.pen!.y));
 const step=(g:VerticalGlyph)=>-(g.font.vertical(g.glyph.code).advance*g.state.fontSize/1000+g.state.charSpacing)*scale.y;
 const bottom=Math.min(...owned.map(g=>g.glyph.pen!.y-step(g)));
 const capacity=top-bottom;if(!(capacity>0))throw Error('vertical-metrics: non-descending source advances');
 return {owned,text,first,scale,pitch,top,bottom,capacity,columns:affected.length,contextText:affected.flat().map(g=>g.text??'').join('')+text,target:new Set(owned.map(g=>verticalAddress(g.glyph)))};
}
/** An overlay builder may split consecutive cells of one source column into
 * lines. When the selection lies in one column, keeps its break count, and
 * every non-final line keeps its cell count, those breaks name no column
 * change: drop them so the text stays in that column. A break that empties a
 * cell, or any break over several source columns, stays a column break. */
function oneColumnText(edit:ContentTextOverlay,columns:number){
 const text=edit.text.normalize('NFC');
 if(columns!==1||!text.includes('\n'))return text;
 const lines=text.split('\n'),source=edit.originalText.normalize('NFC').split('\n'),cells=(line:string)=>Array.from(joinedVertical(line)).length;
 if(lines.length!==source.length||lines.some(l=>!cells(l))||lines.slice(0,-1).some((l,i)=>cells(l)!==cells(source[i]!)))return text;
 return lines.join('');
}
type VerticalPlan=NonNullable<ReturnType<typeof planVertical>>;
export const verticalHome=(plan:VerticalPlan,index:number)=>plan.owned[Math.min(index,plan.owned.length-1)]!;
export function layoutVertical(plan:VerticalPlan,fallback:ReadonlyMap<number,VerticalFont>,stayInColumn=false,sizeScale=1){
 const atoms:VerticalAtom[]=[],s={...plan.first.state,fontSize:plan.first.state.fontSize*sizeScale};let x=plan.owned[0]!.glyph.pen!.x,y=plan.top,column=1,index=0;
 for(const text of plan.text){
  if(text==='\n'){x-=plan.pitch;y=plan.top;column++;continue;}
  if(/\s/u.test(text))throw Error('vertical-glyph: whitespace layout has no vertical glyph proof');
  const original=verticalHome(plan,index),home=sizeScale===1?original:{...original,state:{...original.state,fontSize:original.state.fontSize*sizeScale}};
  let font=home.font,bytes=font.encode(text);
  if(!bytes){font=fallback.get(index)!;bytes=font?.encode(text);}if(!bytes||bytes.length!==2)throw Error('vertical-glyph: output code is unproved');
  index++;
  const code=bytes[0]!*256+bytes[1]!,advance=-(font.vertical(code).advance*s.fontSize/1000+s.charSpacing)*plan.scale.y;
  if(!(advance>0&&advance<=plan.capacity+.01))throw Error('vertical-metrics: output advance exceeds the observed column capacity');
  if(!stayInColumn&&y<plan.top-.01&&y-advance<plan.bottom-.01){x-=plan.pitch;y=plan.top;column++;}
  const pen={x,y},box=verticalGlyphInk(font,code,s,pen);if(!box)throw Error('vertical-glyph: output ink is unproved');
  atoms.push({text,code,font,home,pen,box});y-=advance;
 }
 return{atoms,columns:column,overflowed:column>plan.columns};
}
