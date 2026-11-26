import type {ContentTextOverlay,PdfRect} from '../../model/types';
import {address} from './retypesetSource';
import {columnUnits} from './uprightColumnTcy';
import {columnsOf,type ColumnCell,type ColumnSlot,type planUprightColumn,type uprightColumnSelection} from './uprightColumnPlan';

type Selection=NonNullable<ReturnType<typeof uprightColumnSelection>>;
type CellPlan=ReturnType<typeof planUprightColumn>;
/** A later source cell of the edited column that moves with the edit, by one
 * translation shared with every other cell landing in the same column. */
export type MovedCell={cell:ColumnCell;dx:number;dy:number;group:number};
/** A column the flow wrote into that held none of the paragraph before. */
export type FlowColumn={cx:number;band:PdfRect};
export type FlowPlan=CellPlan&{moved:MovedCell[];wrapped:FlowColumn[];measure?:{cx:number;em:number;top:number;bottom:number}};

// Marks that may not begin a column (closing brackets, stops, small kana,
// prolonged and iteration marks), compatibility forms included via NFKC.
const noColumnStart=/^[、。，．・：；？！）」』】〕〉》｝］〙〗ーぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ々ゝゞヽヾ〜～]/u;

/** Contiguous runs of one centre-x column: a gap over 1.5 pitches (a second
 * tier, a footnote) starts a new run. */
function runsOf(cells:readonly ColumnCell[],step:number){
 return columnsOf(cells).flatMap(k=>{const runs:ColumnCell[][]=[[k[0]!]];for(let i=1;i<k.length;i++){if(k[i-1]!.glyph.y-k[i]!.glyph.y>step*1.5)runs.push([]);runs.at(-1)!.push(k[i]!);}return runs;});
}

/** Reflows an edit whose cell plan grew into later text of its own column or
 * past its measure. The rest of the edited column's run (the paragraph's tail
 * in that column) follows the new text in reading order; text reaching the
 * band's measure continues at the top of the next column to the left, one
 * observed column pitch away. Moved cells keep their source spacing inside
 * each destination column. The caller still proves every destination box
 * against all non-moving ink, paint, page and clip, and every wrapped column
 * band empty. */
export function planUprightFlow(selection:Selection,edit:ContentTextOverlay,base:CellPlan,cells:readonly ColumnCell[]):FlowPlan{
 const {columns,members,em}=selection,step=base.step,last=columns.at(-1)!,lastCell=last.at(-1)!;
 if(edit.text.includes('\n'))throw Error('vertical-layout: explicit column breaks are not reflowed');
 const same=cells.filter(c=>Math.abs(c.em-em)<.05),runs=runsOf(same,step);
 const home=runs.find(r=>r.some(c=>c.glyph===lastCell.glyph));if(!home)throw Error('vertical-layout: edited column run is unproved');
 const top=home[0]!.glyph.y,bottom=home.at(-1)!.glyph.y;
 const band=runs.filter(r=>r[0]!.glyph.y>=bottom-.01&&r.at(-1)!.glyph.y<=top+.01);
 const measureTop=Math.max(...band.map(r=>r[0]!.glyph.y)),measureBottom=Math.min(...band.map(r=>r.at(-1)!.glyph.y));
 const owned=new Set(columns.flat().map(c=>address(c.glyph.glyph)));
 // The tail is the rest of this column inside the band's measure; gaps
 // between its cells move with it. A second tier below the band stays.
 const tail=(members.get(last)??[]).filter(c=>c.glyph.y<lastCell.glyph.y-.01&&c.glyph.y>=measureBottom-.01&&!owned.has(address(c.glyph.glyph)));
 const centres=[...new Set(band.map(r=>r[0]!.cx))].sort((a,b)=>b-a).filter((x,i,a)=>i===0||a[i-1]!-x>em*.3);
 const placed:{text:string;slot:ColumnSlot}[]=[],moved:MovedCell[]=[],wrapped:FlowColumn[]=[];
 const gaps=centres.slice(1).map((x,i)=>centres[i]!-x).sort((a,b)=>a-b),pitch=gaps[Math.floor(gaps.length/2)];
 const lastSlots=last.map(c=>c.glyph.y),sel=columns.length-1,rowY=(r:number)=>r<lastSlots.length?lastSlots[r]!:lastSlots.at(-1)!-step*(r-lastSlots.length+1);
 let column=0,cx=last[0]!.cx,cursor=0,group=0,dx=0,dy:number|undefined;
 const wrap=(text:string)=>{
  if(!pitch||!(pitch>=em)||pitch>em*4)throw Error('vertical-layout: no observed column pitch for a wrap');
  if(noColumnStart.test(text.normalize('NFKC')))throw Error(`vertical-layout: ${JSON.stringify(text)} cannot begin a column`);
  column++;cx-=pitch;cursor=measureTop;group++;dy=undefined;
  wrapped.push({cx,band:{x:cx-em/2,y:measureBottom-em*.5,w:em,h:measureTop-measureBottom+em*1.5}});
 };
 // New text: earlier selected columns keep their cells; the last continues
 // on its own cells, then at the observed pitch down to the measure.
 let col=0,row=0;const placedColumn:number[]=[];
 for(const ch of columnUnits(edit.text.normalize('NFC'))){
  if(/\s/u.test(ch))throw Error('vertical-glyph: whitespace layout has no vertical glyph proof');
  while(col<sel&&row>=columns[col]!.length){col++;row=0;}
  if(col<sel){const c=columns[col]![row++]!;placed.push({text:ch,slot:{home:c.glyph,font:c.font,cx:c.cx,y:c.glyph.y}});placedColumn.push(-1);continue;}
  let y=column===0?rowY(row):cursor;
  if(y<measureBottom-.01){
   // A mark that may not begin a column takes the glyphs before it along.
   const carried:typeof placed=[];
   while(noColumnStart.test((carried[0]?.text??ch).normalize('NFKC'))&&placedColumn.at(-1)===column&&placed.length>(col<sel?0:1)){carried.unshift(placed.pop()!);placedColumn.pop();}
   wrap(carried[0]?.text??ch);
   for(const p of carried){placed.push({text:p.text,slot:{...p.slot,cx,y:cursor}});placedColumn.push(column);cursor-=step;}
   y=cursor;
  }
  const c=column===0&&row<last.length?last[row]!:lastCell;
  placed.push({text:ch,slot:{home:c.glyph,font:c.font,cx:column===0?c.cx:cx,y}});placedColumn.push(column);
  if(column===0){row++;cursor=rowY(row);}else cursor=y-step;
 }
 if(col<sel||!placed.length)throw Error('vertical-layout: shorter text is not reflowed');
 // The tail follows the edit's new end, keeping its gap to the last selected
 // cell; a cell reaching the measure starts the next column at its top.
 // Each destination column moves its cells by one shared translation.
 const end=placed.at(-1)!.slot.y;
 for(let i=0;i<tail.length;i++){
  let c=tail[i]!;
  if(dy===undefined){dx=cx-last[0]!.cx;dy=end-lastCell.glyph.y;}
  if(c.glyph.y+dy<measureBottom-.01){
   // A mark that may not begin a column takes the cell before it along.
   while(noColumnStart.test((c.glyph.text??'').normalize('NFKC'))&&moved.at(-1)?.group===group&&i>0&&moved.at(-1)!.cell===tail[i-1]){moved.pop();c=tail[--i]!;}
   wrap(c.glyph.text??'');dx=cx-last[0]!.cx;dy=measureTop-c.glyph.y;
  }
  moved.push({cell:c,dx,dy,group});
 }
 if(moved.every(m=>Math.abs(m.dx)<1e-9&&Math.abs(m.dy)<1e-9)&&!wrapped.length)throw Error('vertical-layout: flow moves nothing');
 return{...base,placed,moved,wrapped,columns:selection.columns.length+wrapped.length,overflowed:true,measure:{cx:last[0]!.cx,em,top:measureTop,bottom:measureBottom}};
}

/** Other glyphs inside the edited column's band below the selection (a
 * rotated Latin word, a rotated dash) ride with the tail cell above them, so
 * the column moves as one. A rider that would leave the measure is refused. */
export function attachRiders(plan:FlowPlan,candidates:readonly {cell:ColumnCell;box:PdfRect}[],selectionBottom:number){
 const m=plan.measure;if(!m)return[];
 const inBand=candidates.filter(({box:b})=>b.w>0&&b.x>=m.cx-m.em*.6&&b.x+b.w<=m.cx+m.em*.6&&b.y+b.h<=selectionBottom+.01&&b.y>=m.bottom-m.em);
 return inBand.map(({cell,box})=>{
  const above=plan.moved.filter(t=>t.cell.glyph.y>=box.y+box.h-m.em).at(-1)??plan.moved[0];
  if(!above)throw Error('vertical-layout: rotated text in the column has no moving neighbour');
  if(box.y+above.dy<m.bottom-m.em*.5)throw Error('vertical-layout: moved rotated text leaves the measure');
  return{cell,dx:above.dx,dy:above.dy,group:above.group} satisfies MovedCell;
 });
}
