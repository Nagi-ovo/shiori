import {replaceRuns,type ResolvedRunFont,type RunEdit,type RunResult} from '../contentStreamEdit/replaceRun';
import {pageRunPlan,type PageRunPlan} from '../contentStreamEdit/pageRunPlan';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {same} from '../contentStreamEdit/runEncoding';
import {compileReflowPlan} from './reflowCompile';

export const lastEditedOp=(edit:RunEdit)=>edit.closeUpThrough?.opIndex??edit.opIndex;
export const recipeWindows=(p:PageRunPlan)=>[...(p.reflow?[p.reflow]:[]),...(p.reflows??[])].map(r=>({first:r.firstOp,last:r.lastOp}));
/** Every patch is compiled against the SAME immutable revision. Extract its
 * original operator window, then splice disjoint windows once; no rebasing. */
export function compilePageReflows(content:Uint8Array,fonts:readonly ResolvedRunFont[],plan:PageRunPlan):RunResult {
 const recipes=[...(plan.reflow?[plan.reflow]:[]),...(plan.reflows??[])];
 if(!recipes.length)return replaceRuns(content,fonts,pageRunPlan(plan));
 const fail=(reason:string):RunResult=>({ok:false,bytes:content,code:'unsupported-state',reason});
 const ops=tokenizeContentStream(content),windows=recipes.map(r=>({first:r.firstOp,last:r.lastOp,recipe:r})).sort((a,b)=>a.first-b.first);
 if(windows.some((w,i)=>!ops[w.first]||!ops[w.last]||w.first>w.last||i>0&&w.first<=windows[i-1]!.last))return fail('intersecting reflow ownership');
 if(plan.edits.some(e=>e.closeUpThrough&&windows.some(w=>e.opIndex<=w.last&&lastEditedOp(e)>=w.first)))
  return fail('intersecting reflow/deletion ownership');
 const {reflow:_,reflows:__,...base}=plan;void _;void __;
 const parts:{start:number;end:number;bytes:Uint8Array}[]=[];
 const compileWindow=(first:number,last:number,p:PageRunPlan):RunResult=>{
  const result=compileReflowPlan(content,fonts,p.reflow?p:pageRunPlan(p));if(!result.ok)return result;
  const start=ops[first]!.start,end=ops[last]!.end,tail=content.length-end;
  if(!same(result.bytes.subarray(0,start),content.subarray(0,start))||
   !same(result.bytes.subarray(result.bytes.length-tail),content.subarray(end)))return fail('compiler changed bytes outside owned window');
  parts.push({start,end,bytes:result.bytes.slice(start,result.bytes.length-tail)});return result;
 };
 for(const w of windows){
  const edits=plan.edits.filter(e=>e.opIndex>=w.first&&e.opIndex<=w.last);
  // A recipe owns complete verification deletions, never a second edit to
  // one of those shows. Apply also reports both conflicting overlays.
  if(edits.some(e=>e.replacement!==''||e.byteStart!==0)||edits.length!==w.recipe.proof.owned.filter(s=>s.opIndex>=w.first).length)
   return fail('intersecting reflow/fixed ownership');
  const result=compileWindow(w.first,w.last,{...base,edits,reflow:w.recipe});if(!result.ok)return result;
 }
 const fixed=plan.edits.filter(e=>!windows.some(w=>e.opIndex>=w.first&&e.opIndex<=w.last));
 const groups:{first:number;last:number;edits:typeof fixed}[]=[];
 for(const edit of fixed.sort((a,b)=>a.opIndex-b.opIndex)){
  const previous=groups.at(-1),last=lastEditedOp(edit);
  if(previous&&edit.opIndex<=previous.last){
   previous.last=Math.max(previous.last,last);
   previous.edits.push(edit);
  }else groups.push({first:edit.opIndex,last,edits:[edit]});
 }
 for(const {first,last,edits}of groups){const result=compileWindow(first,last,{...base,edits});if(!result.ok)return result;}
 parts.sort((a,b)=>a.start-b.start);let cursor=0,length=content.length;
 for(const p of parts)length+=p.bytes.length-(p.end-p.start);
 const bytes=new Uint8Array(length);let offset=0;
 for(const p of parts){const prefix=content.subarray(cursor,p.start);bytes.set(prefix,offset);offset+=prefix.length;bytes.set(p.bytes,offset);offset+=p.bytes.length;cursor=p.end;}
 bytes.set(content.subarray(cursor),offset);return {ok:true,bytes};
}
