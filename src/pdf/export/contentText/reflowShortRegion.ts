import type {ParagraphInput,RegionProof,TextTrace} from './regionProof';
import {proveOperators} from './regionProof/operators';
import {compatible,paragraphMember,anchorForShow,lineAnchors,contains,intersects,matrixEqual,near,origin,physicalLeading,validTrace} from './regionProof/geometry';
/** Short stream candidates use their observed advance widths only. Two rows
 * prove a leading, not a wider column; a single row needs explicit TL to grow.
 * The preceding numeric snapshot proves relative first anchors from the same
 * immutable walk. Overlay newlines never contribute capacity or ownership.
 */
export function shortStreamRegion(input:ParagraphInput,before?:TextTrace):RegionProof|null{
 const {lines,evidence:e}=input,base=lines[0]?.shows[0]?.before;
 if(!base||!validTrace(base)||lines.length>2)return null;
 for(const line of lines){
  if(lineAnchors(line).some(t=>!paragraphMember(t,base))||!line.ink||!line.shows.length)return null;
  for(const s of line.shows){
   const anchor=anchorForShow(line,s.source.opIndex);
   if(!anchor||!s.unicode||/[\r\n\t\uFFFD\u0590-\u08ff\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(s.unicode)||
    !paragraphMember(s.before,base)||!compatible(s.after,s.before)||!matrixEqual(s.before.tlm,anchor.tlm)||!matrixEqual(s.after.tlm,anchor.tlm))return null;
  }
 }
 const operators=proveOperators(input,before);if('blocker'in operators)return null;
 const starts=lines.map(l=>origin(l.shows[0]!.before)),ends=operators.endpoints;
 const explicit=physicalLeading(base),leading=lines.length===2?starts[0]![1]-starts[1]![1]:explicit;
 if(leading<0||lines.length===2&&(!(leading>0)||explicit>0&&!near(leading,explicit,.1)))return null;
 const validLeading=(t:TextTrace)=>lines.length===2?(physicalLeading(t)===0||near(physicalLeading(t),leading,.1)):near(physicalLeading(t),explicit,.1);
 if(lines.some(l=>lineAnchors(l).some(t=>!validLeading(t))||l.shows.some(s=>!validLeading(s.before)||!validLeading(s.after))))return null;
 // No capacity beyond the first observed right edge. A longer second row
 // has no short-paragraph column proof and must use a separate candidate.
 const right=ends[0]!;if(ends.some(v=>v>right+1e-7)||starts.some(p=>p[0]>=right))return null;
 const left=Math.min(...starts.map(p=>p[0]),...lines.map(l=>l.ink!.x)),bottom=Math.min(...lines.map(l=>l.ink!.y))-.5,top=Math.max(...lines.map(l=>l.ink!.y+l.ink!.h))+.5;
 const box={x:left,y:bottom,w:right-left,h:top-bottom};
 if(!contains(e.crop,box)||!contains(e.clip,box)||lines.some(l=>!contains(box,l.ink!))||e.obstacles.some(o=>!o.box||intersects(o.box,box)))return null;
 if(lines.length===2&&lines[1]!.ink!.y+lines[1]!.ink!.h>lines[0]!.ink!.y)return null;
 const firstLeft=starts[0]![0],bodyLeft=starts[1]?.[0]??firstLeft;
 return {kind:lines.length===1?'explicit-line-region':'paragraph',sourceHash:input.sourceHash,dependencyHash:input.dependencyHash,bt:base.bt,box,
  indent:{kind:near(firstLeft,bodyLeft,.01)?'flush':firstLeft>bodyLeft?'first-line':'hanging',amountPt:Math.abs(firstLeft-bodyLeft)},leadingPt:leading,
  lineSlots:starts.map(p=>({left:p[0],right,baseline:p[1],kind:'observed'})),owned:lines.flatMap(l=>l.shows.map(s=>s.source)),tjBoundaries:operators.boundaries,
  obstacleProofHash:e.obstacleProofHash,boundaryProofHash:e.boundaryProofHash,scopeProofHash:e.scopeProofHash};
}
