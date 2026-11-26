import type {ContentTextOverlay} from '../../model/types';
import type {ResolvedRunFont} from '../contentStreamEdit/replaceRun';
import type {RetypesetGlyph} from './retypesetTypes';
import {columnCells} from './uprightColumnPlan';

const nf=(c:string)=>c.normalize('NFKC');
const chars=(text:string)=>Array.from(text.replace(/\s/gu,''));
// Splits beyond this many states are not searched; the overlay is refused.
const SPLIT_STATES=20000;

/** The column of every character when the text splits into the given
 * columns (each read top down) in exactly one way; undefined when it does
 * not split or splits two ways. */
function uniqueSplit(all:readonly string[],columns:readonly (readonly string[])[]){
 if(columns.reduce((n,k)=>n*(k.length+1),1)>SPLIT_STATES)return;
 const memo=new Map<string,number>(),cursor=columns.map(()=>0);
 // Number of splits of the rest, capped at two.
 const count=(i:number):number=>{
  if(i===all.length)return 1;
  const key=cursor.join(),cached=memo.get(key);if(cached!==undefined)return cached;
  let n=0;
  for(const [k,column]of columns.entries())if(cursor[k]!<column.length&&nf(column[cursor[k]!]!)===nf(all[i]!)){
   cursor[k]!++;n+=count(i+1);cursor[k]!--;
   if(n>1)break;
  }
  memo.set(key,Math.min(n,2));return Math.min(n,2);
 };
 if(count(0)!==1)return;
 const owner:number[]=[];cursor.fill(0);
 for(let i=0;i<all.length;i++){
  for(const [k,column]of columns.entries())if(cursor[k]!<column.length&&nf(column[cursor[k]!]!)===nf(all[i]!)){
   cursor[k]!++;if(count(i+1)){owner.push(k);break;}cursor[k]!--;
  }
 }
 return owner;
}

/** The changed span [from,to) of `original`, with common prefix taken first
 * or common suffix taken first. */
function changedSpan(original:readonly string[],next:readonly string[],suffixFirst:boolean){
 const same=(a:string|undefined,b:string|undefined)=>a!==undefined&&b!==undefined&&nf(a)===nf(b);
 let p=0,q=0;
 const prefix=()=>{while(p<original.length-q&&p<next.length-q&&same(original[p],next[p]))p++;};
 const suffix=()=>{while(q<original.length-p&&q<next.length-p&&same(original.at(-1-q),next.at(-1-q)))q++;};
 if(suffixFirst){suffix();prefix();}else{prefix();suffix();}
 return{from:p,to:original.length-q,inserted:next.slice(p,next.length-q)};
}

/** The one column an edit of an interleaved overlay belongs to. The
 * overlay's text (whitespace aside) must split into the columns, each read
 * top down, in exactly one way; every changed character must lie in one
 * column of at least three cells; a pure insertion must sit next to that
 * column's cells only (or belong to a column holding three quarters of the
 * cells when every other column is a single stray cell);
 * and the prefix-first and suffix-first diffs must agree. Every other
 * column's characters stay where they are. Shared with the corpus oracle,
 * which finds the columns from native origins on its own. */
export function interleavedColumnText(originalText:string,editedText:string,columns:readonly (readonly string[])[]){
 if(originalText.includes('\n')||editedText.includes('\n')||columns.length<2)return;
 const original=chars(originalText),next=chars(editedText);
 if(original.length!==columns.reduce((n,k)=>n+k.length,0)||columns.some(k=>k.some(t=>Array.from(t).length!==1)))return;
 const owner=uniqueSplit(original,columns);if(!owner)return;
 const total=original.length,dominant=columns.findIndex(k=>k.length>=total*.75&&columns.every(o=>o===k||o.length===1));
 const read=(suffixFirst:boolean)=>{
  const {from,to,inserted}=changedSpan(original,next,suffixFirst);
  if(from===to&&!inserted.length)return;
  const touched=new Set(owner.slice(from,to));
  // Beside single stray cells, an insertion belongs to the dominant column.
  if(from===to){if(dominant>=0)touched.add(dominant);else for(const i of [from-1,to])if(i>=0&&i<total)touched.add(owner[i]!);}
  if(touched.size!==1)return;
  const column=[...touched][0]!;if(columns[column]!.length<3)return;
  const kept=(a:number,b:number)=>original.filter((_,i)=>owner[i]===column&&i>=a&&i<b).join('');
  return{column,originalText:kept(0,total),text:kept(0,from)+inserted.join('')+kept(to,total)};
 };
 const a=read(false),b=read(true);
 if(!a||!b||a.column!==b.column||a.text!==b.text||a.originalText===a.text)return;
 return a;
}

/** A selection whose text interleaves cells of several columns (staggered
 * columns share rows, so a row-built overlay picks them up) is re-addressed
 * to the one column its edit changes, under interleavedColumnText's rule.
 * The other columns' cells then stay as fixed ink. */
export function interleavedColumnEdit(hits:readonly RetypesetGlyph[],fonts:readonly ResolvedRunFont[],edit:ContentTextOverlay){
 const columns=columnCells(hits,fonts);if(!columns)return;
 const text=interleavedColumnText(edit.originalText,edit.text,columns.map(k=>k.map(c=>c.glyph.text??'')));
 return text&&{hits:columns[text.column]!.map(c=>c.glyph),edit:{...edit,originalText:text.originalText,text:text.text}};
}
