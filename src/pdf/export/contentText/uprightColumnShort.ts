import type {ContentTextOverlay} from '../../model/types';
import type {ResolvedRunFont} from '../contentStreamEdit/replaceRun';
import type {RetypesetGlyph} from './retypesetTypes';
import {bounds} from './retypesetInk';
import {columnCells,uprightCell,uprightColumnSelection} from './uprightColumnPlan';

/** A stacked cell (centre x, origin y, em) and the centre of any page glyph. */
export type GridCell={cx:number;y:number;em:number};
export type GridGlyph={cx:number;y:number};

// Row neighbours nearer than this many column steps are a horizontal line.
const ROW_CLEAR=1.3;
const sameStep=(d:number,step:number)=>Math.abs(d-step)<=step*.03;

/** The run of `cells` (one column, top down) through `start` whose rows all
 * stack at `step`. */
function stackedRun(cells:readonly GridCell[],start:GridCell,step:number){
 const list=[...cells].sort((a,b)=>b.y-a.y),at=list.indexOf(start);
 let lo=at,hi=at;
 while(lo>0&&sameStep(list[lo-1]!.y-list[lo]!.y,step))lo--;
 while(hi<list.length-1&&sameStep(list[hi]!.y-list[hi+1]!.y,step))hi++;
 return list.slice(lo,hi+1);
}

/** Proves that a short selected column (two or more stacked cells, fewer
 * than the three the selection rule needs, or broken into overlay lines) is
 * an upright column from the page grid around it, never from the selection
 * alone. The selected cells stack at one step of 0.8 to 1.25 em; a run of at
 * least three page cells of the same size stacks at that step either through
 * the selection in its own page column, or in the column holding the nearest
 * glyph on every selected row, aligned row for row with the selection. No
 * glyph of any size sits nearer than 1.3 steps on any row of the selection
 * or of that run. Horizontal text fails the last condition: its next glyph
 * on a line is about one em away, so stacked line starts are never a column. */
export function gridColumnProof(column:readonly GridCell[],cells:readonly GridCell[],glyphs:readonly GridGlyph[]){
 const k=[...column].sort((a,b)=>b.y-a.y);
 if(k.length<2)return false;
 const em=k[0]!.em;
 if(k.some(c=>Math.abs(c.em-em)>.05||Math.abs(c.cx-k[0]!.cx)>em*.3))return false;
 const step=k[0]!.y-k[1]!.y;
 if(!(step>=em*.8&&step<=em*1.25)||k.some((c,i)=>i>0&&!sameStep(k[i-1]!.y-c.y,step)))return false;
 const onRow=(c:GridCell,g:GridGlyph)=>Math.abs(g.y-c.y)<em*.5;
 const nearest=(c:GridCell)=>{let best:GridGlyph|undefined,d=Infinity;for(const g of glyphs)if(onRow(c,g)&&!(Math.abs(g.cx-c.cx)<1e-6&&Math.abs(g.y-c.y)<1e-6)&&Math.abs(g.cx-c.cx)<d){d=Math.abs(g.cx-c.cx);best=g;}return{g:best,d};};
 const clear=(list:readonly GridCell[])=>list.every(c=>nearest(c).d>=step*ROW_CLEAR);
 if(!clear(k))return false;
 const peers=cells.filter(c=>Math.abs(c.em-em)<=.05),columnOf=(x:number)=>peers.filter(c=>Math.abs(c.cx-x)<em*.3);
 // The selection's own page column.
 const own=columnOf(k[0]!.cx),top=own.find(c=>Math.abs(c.y-k[0]!.y)<1e-6);
 if(top){const run=stackedRun(own,top,step);if(run.length>=3&&k.every(c=>run.some(r=>Math.abs(r.y-c.y)<1e-6))&&clear(run))return true;}
 // The column of the nearest glyph on every selected row, aligned row for row.
 const near=k.map(c=>nearest(c).g);
 if(near.some(g=>!g))return false;
 const x=near[0]!.cx;
 if(near.some(g=>Math.abs(g!.cx-x)>em*.3))return false;
 const other=columnOf(x),aligned=k.map(c=>other.find(o=>Math.abs(o.y-c.y)<em*.05));
 if(aligned.some(a=>!a))return false;
 const run=stackedRun(other,aligned[0]!,step);
 return run.length>=3&&aligned.every(a=>run.includes(a!))&&clear(run);
}

/** Overlay lines over one column are its rows: the breaks carry no layout,
 * so they are dropped only when the edit keeps exactly as many. */
export function rowBrokenColumnEdit(edit:ContentTextOverlay){
 if(!edit.originalText.includes('\n'))return edit;
 const breaks=(s:string)=>s.split('\n').length-1;
 if(breaks(edit.text)!==breaks(edit.originalText))return;
 return{...edit,originalText:edit.originalText.replace(/\n/gu,''),text:edit.text.replace(/\n/gu,'')};
}

/** A selection of one column the stacked-selection rule cannot take (two
 * cells, or cells split into overlay lines), accepted only under
 * gridColumnProof and the column text rule. */
export function shortColumnEdit(glyphs:readonly RetypesetGlyph[],hits:readonly RetypesetGlyph[],fonts:readonly ResolvedRunFont[],edit:ContentTextOverlay){
 const columns=columnCells(hits,fonts);
 if(columns?.length!==1||columns[0]!.length<2)return;
 const addressed=rowBrokenColumnEdit(edit);if(!addressed)return;
 const cells=glyphs.flatMap(g=>{const c=uprightCell(g,fonts);return c?[{cx:c.cx,y:c.glyph.y,em:c.em}]:[];});
 const centres=glyphs.map(g=>{const c=uprightCell(g,fonts);if(c)return{cx:c.cx,y:g.y};const b=bounds(g.glyph.quad);return{cx:b.x+b.w/2,y:g.y};});
 if(!gridColumnProof(columns[0]!.map(c=>({cx:c.cx,y:c.glyph.y,em:c.em})),cells,centres))return;
 const selection=uprightColumnSelection(glyphs,hits,fonts,addressed,columns);
 return selection&&{edit:addressed,selection};
}
