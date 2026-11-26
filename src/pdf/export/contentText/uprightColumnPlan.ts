import type {ContentTextOverlay} from '../../model/types';
import type {ResolvedRunFont} from '../contentStreamEdit/replaceRun';
import type {ShowTextState} from '../contentStreamEdit/textState';
import type {RetypesetGlyph} from './retypesetTypes';
import {address} from './retypesetSource';
import {columnUnits} from './uprightColumnTcy';

/** A column cell: one source glyph shown upright by a horizontal-mode font,
 * stacked below its predecessor. Producers place each such glyph with its
 * own matrix; pitch comes from observed origins, never from ink. */
export type ColumnCell={glyph:RetypesetGlyph;font:ResolvedRunFont;cx:number;em:number;width:number};
export type ColumnSlot={home:RetypesetGlyph;font:ResolvedRunFont;cx:number;y:number};
// Compatibility and vertical presentation forms read as their base scalar.
const joined=(text:string)=>text.replace(/\s/gu,'').normalize('NFKC');

export function uprightScale(s:ShowTextState){
 const m=s.textMatrix!,c=s.ctm!;
 const a=m[0]!*c[0]!+m[1]!*c[2]!,b=m[0]!*c[1]!+m[1]!*c[3]!,cc=m[2]!*c[0]!+m[3]!*c[2]!,d=m[2]!*c[1]!+m[3]!*c[3]!;
 if(!(a>0&&d>0)||Math.abs(b)>1e-8||Math.abs(cc)>1e-8||!(s.horizontalScale!>0))return;
 return{x:a*s.horizontalScale!,y:d};
}
export function uprightCell(g:RetypesetGlyph,fonts:readonly ResolvedRunFont[]):ColumnCell|undefined{
 const font=fonts.find(f=>f.resourceName===g.glyph.fontName),scale=uprightScale(g.state);
 if(!font||!scale||g.state.renderMode===3||g.state.renderMode===7)return;
 const width=font.widthOf(g.glyph.code)*g.state.fontSize/1000*scale.x;
 if(!Number.isFinite(width))return;
 return{glyph:g,font,cx:g.x+width/2,em:g.state.fontSize*scale.y,width};
}
/** Groups cells into columns by centre x, right to left, each top to bottom. */
export function columnsOf(cells:readonly ColumnCell[]){
 const columns:ColumnCell[][]=[];
 for(const c of [...cells].sort((a,b)=>b.cx-a.cx)){
  const column=columns.find(k=>Math.abs(k[0]!.cx-c.cx)<k[0]!.em*.3);
  if(column)column.push(c);else columns.push([c]);
 }
 for(const k of columns)k.sort((a,b)=>b.glyph.y-a.glyph.y);
 return columns;
}
/** Every hit an upright cell, grouped into columns none of which holds two
 * cells on one row. */
export function columnCells(hits:readonly RetypesetGlyph[],fonts:readonly ResolvedRunFont[]){
 const cells=hits.map(g=>uprightCell(g,fonts));if(cells.some(c=>!c))return;
 const columns=columnsOf(cells as ColumnCell[]);
 for(const k of columns)for(let i=1;i<k.length;i++)if(k[i-1]!.glyph.y-k[i]!.glyph.y<k[i]!.em*.5)return;
 return columns;
}
/** At least three upright cells per column on average, none sharing a row. */
export function stackedCells(hits:readonly RetypesetGlyph[],fonts:readonly ResolvedRunFont[]){
 if(hits.length<3)return;
 const columns=columnCells(hits,fonts);
 return columns&&hits.length/columns.length>=3?columns:undefined;
}
/** Decides whether a selection is an upright vertical column. Every selected
 * glyph must stack in a column (no two on one row), columns must average at
 * least three cells, and the column reading order must spell the overlay's
 * source text. Horizontal lines and their paragraphs never satisfy this.
 * `proved` replaces the stacking rule with columns already proved upright
 * (uprightColumnShort's page-grid proof); the text rule still applies. */
export function uprightColumnSelection(glyphs:readonly RetypesetGlyph[],hits:readonly RetypesetGlyph[],fonts:readonly ResolvedRunFont[],edit:ContentTextOverlay,proved?:ColumnCell[][]){
 if(edit.originalText.includes('\n'))return;
 const columns=proved??stackedCells(hits,fonts);if(!columns)return;
 if(joined(columns.flat().map(c=>c.glyph.text??'�').join(''))!==joined(edit.originalText))return;
 const em=columns[0]![0]!.em,members=new Map<ColumnCell[],ColumnCell[]>();
 // Same-column neighbours of the selection share its frame and size.
 const others=glyphs.flatMap(g=>{const c=uprightCell(g,fonts);return c&&Math.abs(c.em-em)<.05?[c]:[];});
 for(const k of columns)members.set(k,others.filter(c=>Math.abs(c.cx-k[0]!.cx)<k[0]!.em*.3).sort((a,b)=>b.glyph.y-a.glyph.y));
 return{columns,members,em};
}
/** Reading-order contiguity: inside a column every member between the first
 * and last selected cell is selected; a column that continues into the next
 * must end at its last cell, and a continued column must begin at its first. */
export function planUprightColumn(selection:NonNullable<ReturnType<typeof uprightColumnSelection>>,edit:ContentTextOverlay){
 const {columns,members}=selection,owned=new Set(columns.flat().map(c=>address(c.glyph.glyph)));
 const steps:number[]=[];
 for(const [i,k]of columns.entries()){
  const all=members.get(k)!,top=k[0]!.glyph.y,bottom=k.at(-1)!.glyph.y,pitch=k.length>1?(top-bottom)/(k.length-1):k[0]!.em;
  if(all.some(c=>c.glyph.y<=top+.01&&c.glyph.y>=bottom-.01&&!owned.has(address(c.glyph.glyph))))throw Error('vertical-source: discontiguous column selection');
  if(i<columns.length-1&&all.some(c=>c.glyph.y<bottom-.01&&c.glyph.y>bottom-pitch*1.5))throw Error('vertical-source: selection skips the rest of a column');
  if(i>0&&all.some(c=>c.glyph.y>top+.01&&c.glyph.y<top+pitch*1.5))throw Error('vertical-source: selection skips the start of a column');
  for(let j=1;j<k.length;j++)steps.push(k[j-1]!.glyph.y-k[j]!.glyph.y);
 }
 if(!edit.sourceStyle||(['fontSize','color','bold','italic','align','fontFamily','backgroundColor']as const).some(key=>edit[key]!==edit.sourceStyle![key]))throw Error('vertical-style: style changes require separate metric and paint proof');
 const step=steps.length?steps.sort((a,b)=>a-b)[Math.floor(steps.length/2)]!:selection.em;
 if(!(step>=selection.em*.8))throw Error('vertical-metrics: column pitch is tighter than the glyph size');
 // Source cells are the slots. Longer text continues down the last column at
 // the observed pitch; the mask and obstacle proofs bound that growth.
 const slots:ColumnSlot[][]=columns.map(k=>k.map(c=>({home:c.glyph,font:c.font,cx:c.cx,y:c.glyph.y})));
 const text=edit.text.normalize('NFC'),placed:{text:string;slot:ColumnSlot}[]=[];
 let column=0,row=0;
 for(const ch of columnUnits(text)){
  if(ch==='\n'){column++;row=0;if(column>=slots.length)throw Error('vertical-layout: line break beyond the selected columns');continue;}
  if(/\s/u.test(ch))throw Error('vertical-glyph: whitespace layout has no vertical glyph proof');
  while(row>=slots[column]!.length&&column<slots.length-1){column++;row=0;}
  const list=slots[column]!,last=list.at(-1)!;
  const slot=row<list.length?list[row]!:{...last,y:last.y-step*(row-list.length+1)};
  placed.push({text:ch,slot});row++;
 }
 return{owned:columns.flat(),placed,step,columns:columns.length,overflowed:placed.some(p=>!columns.some(k=>k.some(c=>c.glyph===p.slot.home&&c.glyph.y===p.slot.y)))};
}
