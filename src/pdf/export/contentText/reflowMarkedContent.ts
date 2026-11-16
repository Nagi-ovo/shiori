import type {GlyphPlacement} from '../contentStreamEdit/textState';
import {codes} from '../contentStreamEdit/runEncoding';
import type {ResolvedRunFont} from '../contentStreamEdit/replaceRun';
import type {ReflowRecipe} from './reflowTypes';
import {ReflowTraceError,type traceReflowSource} from './reflowTrace';
import {homeOp} from './reflowEmit';

type Trace=ReturnType<typeof traceReflowSource>;
type Codes=Map<number,string[]>;
const glyphKey=(g:GlyphPlacement)=>`${g.opIndex}:${g.arrayItemIndex}:${g.byteOffset}`;
const append=(out:Codes,ids:readonly number[],code:string)=>{for(const id of ids){const row=out.get(id)??[];row.push(code);out.set(id,row);}};
const state=(trace:Trace,g:GlyphPlacement)=>trace.shows.get(`${g.opIndex}:${g.arrayItemIndex}`)!.before;
const identity=(trace:Trace,g:GlyphPlacement)=>`${state(trace,g).fontObject}:${g.code}`;

/** Independently derive the one permitted code change from original glyph
 * addresses, never from the compiler's emitted MCID membership. */
export function expectedMarkedCodes(glyphs:readonly GlyphPlacement[],trace:Trace,recipe:ReflowRecipe,fonts:readonly ResolvedRunFont[]):Codes{
 const surviving=new Set(recipe.clusters.flatMap(t=>t.source?[`${t.source.opIndex}:${t.source.itemIndex}:${t.source.byteStart}`]:[]));
 const owned=glyphs.filter(g=>g.opIndex>=recipe.firstOp&&g.opIndex<=recipe.lastOp),removed=owned.filter(g=>!surviving.has(glyphKey(g)));
 const replacement=recipe.clusters.filter(t=>!t.source),first=removed[0];
 if(!first||!replacement.length)throw new ReflowTraceError('missing replacement ownership');
 const base=state(trace,first),membership=JSON.stringify(base.mcids??[]);
 if(removed.some((g,i)=>JSON.stringify(state(trace,g).mcids??[])!==membership||state(trace,g).scopeKey!==base.scopeKey||
  i>0&&owned.indexOf(g)!==owned.indexOf(removed[i-1]!)+1))throw new ReflowTraceError('replacement crosses marked-content boundary');
 if(replacement.some(t=>homeOp(t)!==first.opIndex))throw new ReflowTraceError('replacement home differs from its source MCID slot');
 const out:Codes=new Map(),deleted=new Set(removed.map(glyphKey));
 for(const g of glyphs){
  if(g===first)for(const t of replacement){
   const font=fonts.find(f=>f.resourceName===t.fontResource&&f.objectId===t.fontObject);
   if(!font)throw new ReflowTraceError('missing replacement font');
   append(out,base.mcids??[],`${font.objectId}:${codes(t.code,font.bytesPerCode)[0]}`);
  }
  if(!deleted.has(glyphKey(g)))append(out,state(trace,g).mcids??[],identity(trace,g));
 }
 return out;
}
export function markedCodesMatch(expected:Codes,glyphs:readonly GlyphPlacement[],trace:Trace):boolean{
 const actual:Codes=new Map();
 for(const g of glyphs)append(actual,state(trace,g).mcids??[],identity(trace,g));
 return expected.size===actual.size&&[...expected].every(([id,row])=>JSON.stringify(row)===JSON.stringify(actual.get(id)));
}
