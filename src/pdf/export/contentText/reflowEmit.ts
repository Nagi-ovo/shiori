import type {ResolvedRunFont} from '../contentStreamEdit/replaceRun';
import {hex,pdfNumber,pdfName,same,codes,encodeRun} from '../contentStreamEdit/runEncoding';
import {RunCompileError} from '../contentStreamEdit/runRefusal';
import {linear} from './regionProof/geometry';
import type {TextTrace} from './regionProof';
import type {ReflowRecipe} from './reflowTypes';
import {ReflowTraceError} from './reflowTrace';

export const homeOp=(t:ReflowRecipe['clusters'][number])=>t.source?.opIndex??t.homeOp;

/** Each source show owns its paint and marked-content slot, even when its
 * destinations cross visual lines. All coordinates are inverted locally. */
export function emitReflowSlot(recipe:ReflowRecipe,fonts:readonly ResolvedRunFont[],op:number,saved:TextTrace):string[]{
 const {clusters,layout}=recipe,[a,b,c,d,e,f]=saved.ctm,det=a!*d!-b!*c!;
 const scale=linear(saved)[0]!*saved.tz/100;
 if(!Number.isFinite(det)||Math.abs(det)<1e-12||!(scale>0))throw new ReflowTraceError('unsupported emission transform');
 const emitted:{index:number;advance:number}[]=[],body:string[]=[];
 for(let i=0;i<clusters.length;i++){
  const t=clusters[i]!;if(homeOp(t)!==op)continue;
  const font=fonts.find(f=>f.resourceName===t.fontResource&&f.objectId===t.fontObject);
  if(!font)throw new ReflowTraceError('stale output font');
  if(!t.source){const encoded=encodeRun(t.unicode,font,t.code);if(!encoded.ok||!same(encoded.bytes,t.code))throw new RunCompileError('replacement code proof changed','font-coverage');}
  const code=codes(t.code,font.bytesPerCode);
  if(code.length!==1||font.unicodeByCode.get(code[0]!)!==t.unicode)throw new RunCompileError('output code/Unicode differs','font-coverage');
  const metrics=t.metrics??saved;
  const advance=(font.widthOf(code[0]!)*metrics.size/1000+metrics.tc+(font.bytesPerCode===1&&code[0]===32?metrics.tw:0))*scale;
  const measured=t.metrics?layout.clusters[i]?.advance:t.advance;
  if(measured===undefined||Math.abs(advance-measured)>1e-7)throw new ReflowTraceError('layout-metrics-disagreement: current PDF advance changed');
  emitted.push({index:i,advance});
 }
 // Keep source spaces alongside neighbours in each TJ segment. Numbers carry
 // exact destination gaps without changing the original slot's paint state.
 for(let cursor=0;cursor<emitted.length;){
  const first=emitted[cursor]!,t=clusters[first.index]!,[x,y]=layout.origins[first.index]!,metrics=t.metrics??saved;
  const sameMetrics=(index:number)=>{
   const m=clusters[index]!.metrics??saved;
   return m.size===metrics.size&&m.tc===metrics.tc&&m.tw===metrics.tw;
  };
  const items:string[]=[];let end=cursor;
  while(end<emitted.length){
   const entry=emitted[end]!,cluster=clusters[entry.index]!,p=layout.origins[entry.index]!;
   if(cluster.fontResource!==t.fontResource||!sameMetrics(entry.index)||Math.abs(p[1]-y)>1e-9)break;
   items.push(hex(cluster.code));
   const next=emitted[end+1],q=next?layout.origins[next.index]:undefined;end++;
   if(!next||clusters[next.index]!.fontResource!==t.fontResource||!sameMetrics(next.index)||Math.abs(q![1]-y)>1e-9)break;
   const adjustment=(p[0]+entry.advance-q![0])*1000/(metrics.size*scale);
   if(Math.abs(adjustment)>1e-10)items.push(pdfNumber(adjustment));
  }
  if(emitted.slice(cursor,end).every(e=>!clusters[e.index]!.unicode.trim()))throw new ReflowTraceError('reflow-context-unsupported: isolated whitespace fragment');
  const tx=(d!*(x-e!)-c!*(y-f!))/det-saved.rise*saved.tm[2]!;
  const ty=(-b!*(x-e!)+a!*(y-f!))/det-saved.rise*saved.tm[3]!;
  const matrix=[...saved.tm.slice(0,4),tx,ty];
  body.push(`${matrix.map(pdfNumber).join(' ')} Tm ${pdfName(t.fontResource)} ${pdfNumber(metrics.size)} Tf `+
   `${pdfNumber(metrics.tc)} Tc ${pdfNumber(metrics.tw)} Tw [${items.join(' ')}] TJ`);
  cursor=end;
 }
 return body;
}

/** q/Q does not save text matrices. Rejoin both Tm and Tlm after EVERY slot. */
export function restoreReflowSlot(t:TextTrace,fonts:readonly ResolvedRunFont[]):string{
 const length=t.tlm[0]!**2+t.tlm[1]!**2;
 const dx=((t.tm[4]!-t.tlm[4]!)*t.tlm[0]!+(t.tm[5]!-t.tlm[5]!)*t.tlm[1]!)/length;
 if(t.tm.slice(0,4).some((n,i)=>n!==t.tlm[i])||!Number.isFinite(dx)||
  Math.hypot(t.tm[4]!-t.tlm[4]!-dx*t.tlm[0]!,t.tm[5]!-t.tlm[5]!-dx*t.tlm[1]!)>1e-7)throw new ReflowTraceError('unrepresentable Tm/Tlm rejoin');
 const font=fonts.find(f=>f.objectId===t.fontObject);if(!font)throw new ReflowTraceError('missing rejoin font');
 return `${pdfName(font.resourceName)} ${pdfNumber(t.size)} Tf ${pdfNumber(t.tc)} Tc ${pdfNumber(t.tw)} Tw `+
  `${pdfNumber(t.tz)} Tz ${pdfNumber(t.rise)} Ts ${pdfNumber(t.renderMode)} Tr ${pdfNumber(t.leading)} TL `+
  `${t.tlm.map(pdfNumber).join(' ')} Tm [${pdfNumber(-dx*1000/(t.size*t.tz/100))}] TJ`;
}
