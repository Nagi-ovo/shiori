import type {ResolvedRunFont} from '../contentStreamEdit/replaceRun';
import {encodeRun,codes} from '../contentStreamEdit/runEncoding';
import type {columnInk} from './uprightColumnInk';
import type {ColumnAtom} from './uprightColumnEmit';
import {columnsOf,uprightScale,type ColumnCell,type ColumnSlot} from './uprightColumnPlan';

const tcyScalar=/^[A-Za-z0-9À-ɏ]$/u;
/** Text in column order: a run of two or more Latin letters or digits is one
 * horizontal-in-vertical (tate-chu-yoko) unit; everything else is a scalar. */
export const columnUnits=(text:string)=>text.match(/[A-Za-z0-9À-ɏ]{2,}|[\s\S]/gu)??[];
export const isTcyUnit=(unit:string)=>Array.from(unit).length>1;

/** A tate-chu-yoko cell the page already shows: one font, glyphs side by side
 * on one baseline with no gap, centred on a column of upright cells and
 * taking exactly one row of it. `offset` is its baseline against the row an
 * upright cell would use there; `width` the widest such cell. */
export type TcyEvidence={font:ResolvedRunFont;em:number;offset:number;width:number;shown:ReadonlyMap<string,ReadonlySet<number>>};
export function tcyEvidence(cells:readonly ColumnCell[]):TcyEvidence[]{
 const latin=cells.filter(c=>tcyScalar.test(c.glyph.text??'')),set=new Set(latin);
 const columns=columnsOf(cells.filter(c=>!set.has(c))).filter(k=>k.length>=3);
 // Codes each face already shows for a Latin scalar on this page.
 const shown=new Map<string,Set<number>>();
 for(const c of latin){const k=`${c.font.resourceName}:${c.glyph.text}`,v=shown.get(k)??new Set<number>();v.add(c.glyph.glyph.code);shown.set(k,v);}
 const runs:ColumnCell[][]=[];
 for(const c of [...latin].sort((a,b)=>b.glyph.y-a.glyph.y||a.glyph.x-b.glyph.x)){
  const run=runs.find(r=>{const p=r.at(-1)!;return p.font===c.font&&Math.abs(p.glyph.y-c.glyph.y)<.01&&Math.abs(c.em-p.em)<.01&&Math.abs(c.glyph.x-p.glyph.x-p.width)<=c.em*.02;});
  if(run)run.push(c);else runs.push([c]);
 }
 const found:TcyEvidence[]=[];
 for(const run of runs.filter(r=>r.length>=2)){
  const left=run[0]!.glyph.x,right=run.at(-1)!.glyph.x+run.at(-1)!.width,centre=(left+right)/2,y=run[0]!.glyph.y,em=run[0]!.em;
  const column=columns.find(k=>Math.abs(k[0]!.em-em)<.05&&Math.abs(k[0]!.cx-centre)<em*.05);if(!column)continue;
  const above=column.filter(c=>c.glyph.y>y).at(-1),below=column.find(c=>c.glyph.y<y);if(!above||!below)continue;
  const steps=column.slice(1).map((c,i)=>column[i]!.glyph.y-c.glyph.y).sort((a,b)=>a-b),pitch=steps[Math.floor(steps.length/2)]!;
  if(Math.abs(above.glyph.y-below.glyph.y-2*pitch)>em*.1)continue;
  found.push({font:run[0]!.font,em,offset:y-(above.glyph.y+below.glyph.y)/2,width:right-left,shown});
 }
 // Per face and size, every observed cell must agree on its baseline within
 // 0.02 em (their mean is used), or that face has no proof.
 const groups=new Map<string,TcyEvidence[]>();
 for(const e of found){const key=`${e.font.resourceName}:${e.em.toFixed(2)}`;groups.set(key,[...(groups.get(key)??[]),e]);}
 return [...groups.values()].flatMap(list=>{
  const offsets=list.map(e=>e.offset);if(Math.max(...offsets)-Math.min(...offsets)>list[0]!.em*.02)return[];
  return[{...list[0]!,offset:offsets.reduce((a,b)=>a+b,0)/offsets.length,width:Math.max(...list.map(e=>e.width))}];
 });
}

/** Lays a tate-chu-yoko unit into one column row: a face that already shows
 * such a cell at this size, each scalar one code, advances side by side and
 * centred on the column, at the observed baseline offset, no wider than the
 * widest cell the source shows. Anything else is refused by name. */
export function tcyAtoms(unit:string,slot:ColumnSlot,evidence:readonly TcyEvidence[],ink:ReturnType<typeof columnInk>):ColumnAtom[]{
 const s=slot.home.state,scale=uprightScale(s)!,em=s.fontSize*scale.y;
 const proofs=evidence.filter(e=>Math.abs(e.em-em)<.05);
 if(!proofs.length)throw Error(`vertical-glyph: ${JSON.stringify(unit)} is a tate-chu-yoko run; the source shows no tate-chu-yoko cell at this size`);
 let wide=false;
 for(const e of proofs){
  // A code the face already shows for that scalar on this page, else one
  // its coverage encodes.
  const list=Array.from(unit).map(ch=>{
   const seen=e.shown.get(`${e.font.resourceName}:${ch}`);
   if(seen?.size===1){const code=[...seen][0]!;return{ch,code,bytes:e.font.bytesPerCode===1?Uint8Array.of(code):Uint8Array.of(code>>8,code&255)};}
   let r:ReturnType<typeof encodeRun>|undefined;try{r=encodeRun(ch,e.font,new Uint8Array());}catch{r=undefined;}
   const c=r?.ok?codes(r.bytes,e.font.bytesPerCode):[];return c.length===1&&r?.ok?{ch,code:c[0]!,bytes:r.bytes}:undefined;
  });
  if(list.some(g=>!g))continue;
  const widths=list.map(g=>e.font.widthOf(g!.code)*s.fontSize/1000*scale.x),total=widths.reduce((a,b)=>a+b,0);
  if(!widths.every(Number.isFinite))continue;
  if(total>e.width+.01){wide=true;continue;}
  let x=slot.cx-total/2;
  return list.map((g,i)=>{
   const origin={x,y:slot.y+e.offset},measured=ink(e.font,g!.code,s,origin.x,origin.y);x+=widths[i]!;
   if(!measured.known)throw Error('vertical-glyph: tate-chu-yoko ink is unproved');
   return{text:g!.ch,font:e.font,bytes:g!.bytes,code:g!.code,home:slot.home,origin,box:measured.box};
  });
 }
 throw Error(wide?`vertical-glyph: ${JSON.stringify(unit)} is wider than any tate-chu-yoko cell the source shows`:`vertical-glyph: no face of an observed tate-chu-yoko cell encodes ${JSON.stringify(unit)}`);
}
