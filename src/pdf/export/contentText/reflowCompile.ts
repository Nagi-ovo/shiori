import {replaceRuns,sourceFingerprint,type ResolvedRunFont,type RunResult} from '../contentStreamEdit/replaceRun';
import type {PageRunPlan} from '../contentStreamEdit/pageRunPlan';
import {hex,pdfNumber,pdfName,same,codes,encodeRun} from '../contentStreamEdit/runEncoding';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {walkTextPlacements} from '../contentStreamEdit/textState';
import {RunCompileError} from '../contentStreamEdit/runRefusal';
import {linear} from './regionProof/geometry';
import {traceReflowSource,ReflowTraceError} from './reflowTrace';

/** Additive R8 compiler. Existing fixed edits keep replaceRuns. A reflow
 * recipe first uses that compiler for source/font/state verification only,
 * then emits positioned shows inside its owned operator window and restores
 * BOTH Tlm and Tm. Nothing installs bytes before the final independent walk.
 */
export function compileReflowPlan(content:Uint8Array,fonts:readonly ResolvedRunFont[],plan:PageRunPlan):RunResult {
 const refuse=(reason:string,code:'unsupported-state'|'stale-source'|'font-coverage'='unsupported-state'):RunResult=>({ok:false,code,reason,bytes:content});
 if(!plan.reflow)return replaceRuns(content,fonts,plan);
 if(sourceFingerprint(content)!==plan.sourceHash)return refuse('stale source fingerprint','stale-source');
 const {reflow:recipe,...fixed}=plan;
 const verified=replaceRuns(content,fonts,fixed);if(!verified.ok)return verified;
 try{
  const ops=tokenizeContentStream(content),{firstOp,lastOp,rejoin,clusters,layout,proof}=recipe;
  if(!ops[firstOp]||!ops[lastOp]||firstOp>lastOp||clusters.length!==layout.origins.length)
   return refuse('reflow-context-unsupported: invalid owned window');
  const saved=recipe.saved;
  const trace=traceReflowSource(ops,fonts,proof.scopeProofHash);
  const current=trace.shows.get(`${lastOp}:${proof.owned.at(-1)!.itemIndex}`)?.after;
  if(!current||current.fontObject!==rejoin.fontObject||current.tm.some((n,i)=>Math.abs(n-rejoin.tm[i]!)>1e-7)||
   current.tlm.some((n,i)=>Math.abs(n-rejoin.tlm[i]!)>1e-7))return refuse('reflow-context-unsupported: stale rejoin trace');
  const [a,b,c,d,e,f]=saved.ctm,det=a!*d!-b!*c!;
  const scale=linear(saved)[0]!*saved.tz/100;
  if(!Number.isFinite(det)||det<=0||!(scale>0))return refuse('reflow-context-unsupported: unsupported emission transform');
  const body:string[]=[];
  const firstSource=clusters.findIndex(t=>t.source&&t.source.opIndex===firstOp);
  const start=firstSource<0?clusters.findIndex(t=>!t.source):firstSource;
  if(start<0)return refuse('reflow-context-unsupported: empty owned tail');
  let replacementIndex=0;
  for(let i=0;i<clusters.length;i++){
   const t=clusters[i]!,isReplacement=!t.source;
   const reduction=isReplacement?layout.reductions[replacementIndex++]??0:0;
   if(t.source&&t.source.opIndex<firstOp)continue;
   const font=fonts.find(f=>f.resourceName===t.fontResource&&f.objectId===t.fontObject);
   if(!font)return refuse('reflow-context-unsupported: stale output font');
   if(!t.source){const encoded=encodeRun(t.unicode,font,t.code);if(!encoded.ok||!same(encoded.bytes,t.code))return refuse('replacement code proof changed','font-coverage');}
   const code=codes(t.code,font.bytesPerCode);
   if(code.length!==1||font.unicodeByCode.get(code[0]!)!==t.unicode)return refuse('output code/Unicode differs','font-coverage');
   const advance=(font.widthOf(code[0]!)*saved.size/1000+saved.tc+(font.bytesPerCode===1&&code[0]===32?saved.tw:0))*scale;
   if(Math.abs(advance-t.advance)>1e-7)return refuse('layout-metrics-disagreement: current PDF advance changed');
   const [x,y]=layout.origins[i]!;
   const tx=(d!*(x-e!)-c!*(y-f!))/det-saved.rise*saved.tm[2]!;
   const ty=(-b!*(x-e!)+a!*(y-f!))/det-saved.rise*saved.tm[3]!;
   const matrix=[...saved.tm.slice(0,4),tx,ty];
   const tc=saved.tc-(t.wordSpace?0:reduction/scale),tw=saved.tw-(t.wordSpace?reduction/scale:0);
   body.push(`${matrix.map(pdfNumber).join(' ')} Tm ${pdfName(t.fontResource)} ${pdfNumber(saved.size)} Tf `+
    `${pdfNumber(tc)} Tc ${pdfNumber(tw)} Tw ${hex(t.code)} Tj ${pdfNumber(saved.tc)} Tc ${pdfNumber(saved.tw)} Tw`);
  }
  // A proved leading TJ indent is replayed before the first emitted show.
  const leading=proof.tjBoundaries.filter(b=>b.opIndex===firstOp&&b.left===null).map(b=>pdfNumber(b.value));
  if(leading.length)body.unshift(`[${leading.join(' ')}] TJ`);
  const dx=(rejoin.tm[4]!-rejoin.tlm[4]!)/rejoin.tlm[0]!;
  if(rejoin.tm.slice(0,4).some((n,i)=>n!==rejoin.tlm[i])||
   Math.abs(rejoin.tm[5]!-rejoin.tlm[5]!-dx*rejoin.tlm[1]!)>1e-7||!Number.isFinite(dx))
   return refuse('reflow-context-unsupported: unrepresentable Tm/Tlm rejoin');
  body.push(`${pdfNumber(rejoin.leading)} TL ${rejoin.tlm.map(pdfNumber).join(' ')} Tm `+
   `[${pdfNumber(-dx*1000/(rejoin.size*rejoin.tz/100))}] TJ`);
  const patch=new TextEncoder().encode(body.join(' '));
  const prefix=content.subarray(0,ops[firstOp]!.start),suffix=content.subarray(ops[lastOp]!.end);
  const bytes=new Uint8Array(prefix.length+patch.length+suffix.length);
  bytes.set(prefix);bytes.set(patch,prefix.length);bytes.set(suffix,prefix.length+patch.length);
  const resolveFont=(name:string)=>{const font=fonts.find(f=>f.resourceName===name);return font?{...font,ok:true as const,appliesWordSpacing:font.bytesPerCode===1}:null;};
  const before=walkTextPlacements(ops,{resolveFont}),outputOps=tokenizeContentStream(bytes),after=walkTextPlacements(outputOps,{resolveFont});
  if(!before.ok||!after.ok||after.unplacedText)return refuse('reflow-context-unsupported: compiled walk failed');
  const intended=clusters.flatMap((t,i)=>t.source&&t.source.opIndex<firstOp?[]:[{fontName:t.fontResource,code:codes(t.code,resolveFont(t.fontResource)!.bytesPerCode)[0]!,x:layout.origins[i]![0],y:layout.origins[i]![1]}]);
  const unchanged=(g:typeof before.glyphs[number])=>({fontName:g.fontName,code:g.code,x:g.coreQuad[0].x,y:g.coreQuad[0].y});
  const expected=[...before.glyphs.filter(g=>g.opIndex<firstOp).map(unchanged),...intended,...before.glyphs.filter(g=>g.opIndex>lastOp).map(unchanged)];
  if(after.glyphs.length!==expected.length||after.glyphs.some((g,i)=>{const e=expected[i]!;return g.fontName!==e.fontName||g.code!==e.code||Math.hypot(g.coreQuad[0].x-e.x,g.coreQuad[0].y-e.y)>.00001;}))
   return refuse('layout-metrics-disagreement: compiled glyph destinations differ');
  const rewalk=traceReflowSource(outputOps,fonts,proof.scopeProofHash);
  const final=outputOps.findLastIndex(op=>op.end<=prefix.length+patch.length);
  const joined=rewalk.ends.get(final);
  if(!joined||joined.tm.some((n,i)=>Math.abs(n-rejoin.tm[i]!)>1e-7)||joined.tlm.some((n,i)=>Math.abs(n-rejoin.tlm[i]!)>1e-7))
   return refuse('layout-metrics-disagreement: compiled Tm/Tlm rejoin differs');
  return {ok:true,bytes};
 }catch(error){
  if(error instanceof ReflowTraceError)return refuse(error.message);
  if(error instanceof RunCompileError)return {ok:false,code:error.code,reason:error.message,bytes:content};
  throw error;
 }
}
