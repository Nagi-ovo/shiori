import type {PDFPage} from 'pdf-lib';
import {runContextSafety,sourceFingerprint,type ResolvedRunFont} from '../contentStreamEdit/replaceRun';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {walkTextPlacements,type UnplacedShow} from '../contentStreamEdit/textState';
import {textObjectScopes,followsUnplaced} from '../contentStreamEdit/textSafety';
import {runPageEnvironment} from '../contentStreamEdit/replaceRunPage';
import {runResourceStamp} from '../contentStreamEdit/resourceStamp';
import type {Type1Options} from '../fontCoverage/type1Support';
import {detectParagraphRegion,type ParagraphBlocker,type ParagraphRefusal,type ParagraphLine,type RegionProof,type Rect,type SourceAddress} from './regionProof';
import {paragraphFrame,contains,origin,physicalSize,validTrace,linear} from './regionProof/geometry';
import {buildPageOccupancy,boundBoxes,glyphKey,queryOccupancy} from './regionProof/occupancy';
import {traceReflowSource} from './reflowTrace';
import {streamInkResolver} from './reflowInk';
import type {ReflowCodeCluster} from './reflowTypes';
import {shortStreamRegionResult} from './reflowShortRegion';
export const unionReflowBoxes=boundBoxes;
const pageRect=(r:{x:number;y:number;width:number;height:number}):Rect=>({x:r.x,y:r.y,w:r.width,h:r.height});
export type StreamEvidenceGate='placement-walk-failed'|'source-too-large'|'follows-unplaced'|'run-context-unsafe'|
 'target-state'|'missing-show-or-font'|'missing-line-anchor'|'non-string-show-item'|'non-positive-advance'|
 'no-member-lines'|'target-not-in-member-lines'|'region-unproved'|'raster-box-outside-page'|'raster-box-hits-obstacles';
export type StreamEvidenceRefusal={ok:false;gate:StreamEvidenceGate;blocker?:ParagraphBlocker;detail:string};
const refuse=(gate:StreamEvidenceGate,detail:string,blocker?:ParagraphBlocker):StreamEvidenceRefusal=>({ok:false,gate,blocker,detail});
export type StreamReflowEvidence=Extract<ReturnType<typeof streamReflowEvidence>,{ok:true}>;
/** Complete bounded scene proof. Paint and unrelated text are local obstacles;
 * missing bounds conservatively occupy the page, never grant empty space. */
export function streamReflowEvidence(page:PDFPage,content:Uint8Array,fonts:readonly ResolvedRunFont[],targetOp:number,options:Type1Options={},addressOnly=false){
 const ops=tokenizeContentStream(content),sourceHash=sourceFingerprint(content),dependencyHash=runResourceStamp(page);
 const environment=runPageEnvironment(page),unplaced:UnplacedShow[]=[],crop=pageRect(page.getCropBox()),media=pageRect(page.getMediaBox());
 const trace=traceReflowSource(ops,fonts,sourceHash,environment),byName=new Map(fonts.map(f=>[f.resourceName,f]));
 const anchors=[...trace.anchors.values()];
 const resolveFont=(name:string)=>{const f=byName.get(name);return f?{...f,ok:true as const,appliesWordSpacing:f.bytesPerCode===1}:{ok:false as const,reason:'unmeasurable source font'};};
 const walk=walkTextPlacements(ops,{resolveFont,extGStateSetsFont:name=>environment.extGStates?.get(name)?.setsFont??null,onUnplaced:s=>unplaced.push(s)});
 if(!walk.ok)return refuse('placement-walk-failed',walk.reason);
 if(walk.glyphs.length>16384)return refuse('source-too-large',`glyphs=${walk.glyphs.length}`);
 if(followsUnplaced(textObjectScopes(ops),unplaced.filter(s=>!s.advanceKnown).map(s=>s.opIndex),targetOp))return refuse('follows-unplaced','Target follows an unknown text advance');
 const safety=runContextSafety(ops,environment);if(!safety.ok)return refuse('run-context-unsafe',safety.reason);
 const ink=streamInkResolver(page,fonts,options,addressOnly),target=[...trace.shows.values()].find(s=>s.before.opIndex===targetOp)?.before;
 if(!target||!validTrace(target))return refuse('target-state','Missing or unsupported target show state');
 let lines:ParagraphLine[]=[],source:ReflowCodeCluster[]=[];
 const excluded={unmeasured:0,badUnicode:0,unsafe:0,incompatible:0};
 const occupancy=buildPageOccupancy({page,ops,fonts,trace,glyphs:walk.glyphs,unplaced,ink,sourceHash,dependencyHash,media});
 if(occupancy.pageBlocked)return refuse('region-unproved','A media-sized occupant blocks the page','obstacles');
 const obstacles=occupancy.items.filter(o=>o.kind!=='placement').map(o=>o.box);
 for(const g of walk.glyphs){
  const show=trace.shows.get(`${g.opIndex}:${g.arrayItemIndex}`),font=byName.get(g.fontName);
  if(!show||!font)return refuse('missing-show-or-font',`op=${g.opIndex} font=${g.fontName}`);
  const measured=occupancy.glyphs.get(`${g.opIndex}:${g.arrayItemIndex}:${g.byteOffset}`)?.ink,unicode=font.unicodeByCode.get(g.code);
  if(!measured){excluded.unmeasured++;continue;}
  const o=g.coreQuad[0],box={...measured.box,x:o.x+measured.box.x,y:o.y+measured.box.y};
  // Size/rise differences may be an unchanged prefix. Keep their source
  // slots, but defer permission to move them until origins have been solved.
  if(!unicode||/[\r\n\t\uFFFD]/u.test(unicode)||safety.unsafe.has(g.opIndex)||!paragraphFrame(show.before,target)||!paragraphFrame(show.after,target)){
   if(!unicode||/[\r\n\t\uFFFD]/u.test(unicode))excluded.badUnicode++;
   else if(safety.unsafe.has(g.opIndex))excluded.unsafe++;
   else excluded.incompatible++;
   continue;
  }
  const address:SourceAddress={streamHash:sourceHash,opIndex:g.opIndex,itemIndex:g.arrayItemIndex,byteStart:g.byteOffset,byteEnd:g.byteOffset+g.byteLength,fontObject:font.objectId};
  let line=lines.at(-1);
  const anchor=anchors.findLast(t=>t.opIndex<g.opIndex&&t.bt===show.before.bt);
  if(!anchor||!validTrace(anchor))return refuse('missing-line-anchor',`op=${g.opIndex}`);
  const previous=line?.shows.at(-1),previousAnchor=line?.continuations?.at(-1)??line?.anchor;
  const continuation=previous&&anchor.opIndex!==previousAnchor?.opIndex;
  const gap=previous?o.x-origin(previous.after)[0]:0;
  // A new BT/Td may continue a word/space on the same baseline, but a distant
  // column is another row candidate, never whitespace capacity for this one.
  const separated=continuation&&(gap>Math.max(.5,.5*physicalSize(show.before))||gap<-.5);
  const baseline=(t:typeof target)=>origin({...t,rise:target.rise})[1];
  if(!line||Math.abs(baseline(line.shows[0]!.before)-baseline(show.before))>.01||separated){
   line={anchor,baseline:baseline(show.before),shows:[],ink:null};lines.push(line);
  }else if(anchor.opIndex!==line.anchor.opIndex&&!line.continuations?.some(t=>t.opIndex===anchor.opIndex)){
   (line.continuations??=[]).push(anchor);
  }
  if(!line.shows.some(s=>s.source.opIndex===g.opIndex&&s.source.itemIndex===g.arrayItemIndex)){
   const op=ops[g.opIndex]!,item=op.operator==='TJ'&&op.operands[0]?.kind==='array'?op.operands[0].items[g.arrayItemIndex]:op.operands[0];
   if(item?.kind!=='string')return refuse('non-string-show-item',`op=${g.opIndex} item=${g.arrayItemIndex}`);
   line.shows.push({source:{...address,byteStart:0,byteEnd:item.bytes.length},unicode:'',...show});
  }
  line.shows.at(-1)!.unicode+=unicode;line.ink=line.ink?unionReflowBoxes([line.ink,box]):box;
  // coreQuad bounds the glyph's nominal width, excluding Tc/Tw. Paragraph
  // capacity needs its complete measured displacement, including the final
  // character/space of each show; gaps then contain only real positioning.
  const t=show.before,scale=linear(t)[0]!*t.tz/100;
  const advance=(font.widthOf(g.code)*t.size/1000+t.tc+(font.bytesPerCode===1&&g.code===32?t.tw:0))*scale;
  if(!(advance>0))return refuse('non-positive-advance',`op=${g.opIndex} code=${g.code} advance=${advance}`);
  source.push({unicode,advance,metrics:{size:show.before.size,tc:show.before.tc,tw:show.before.tw},ink:measured.box,em:physicalSize(show.before),wordSpace:font.bytesPerCode===1&&g.code===32,
   fullEmHan:font.widthOf(g.code)===1000,gap:0,original:{line:lines.length-1,x:o.x,y:o.y},source:address,glyph:measured.glyph,
   code:font.bytesPerCode===1?Uint8Array.of(g.code):Uint8Array.of(g.code>>8,g.code&255),fontResource:font.resourceName,fontObject:font.objectId});
 }
 if(!lines.length)return refuse('no-member-lines',`glyphs=${walk.glyphs.length} unplaced=${unplaced.length} obstacles=${obstacles.length} excluded=${JSON.stringify(excluded)}`);
 for(let i=0;i<source.length-1;i++)if(source[i]!.original!.line===source[i+1]!.original!.line)
  source[i]!.gap=source[i+1]!.original!.x-source[i]!.original!.x-source[i]!.advance;
 let proof:RegionProof;
 {
  const targetLine=source.find(t=>t.source!.opIndex===targetOp)?.original?.line;if(targetLine===undefined)return refuse('target-not-in-member-lines',`lines=${lines.length} obstacles=${obstacles.length}`);
  // A BT can contain several paragraphs. Try bounded consecutive tails from
  // longest to shortest; every excluded placement becomes an obstacle. The
  // detector still proves all anchors/items in the chosen operator window.
  let chosen:{proof:RegionProof;start:number;end:number}|undefined;
  const failures:{start:number;count:number;failure:ParagraphRefusal}[]=[];
  for(let count=Math.min(lines.length,8);count>=1&&!chosen;count--)for(let start=Math.max(0,targetLine-count+1);start<=targetLine&&start+count<=lines.length;start++){
   const end=start+count;
   const input={sourceHash,dependencyHash,ops,lines:lines.slice(start,end),rasterGuardPt:.5,occupancy,evidence:{sourceHash,dependencyHash,
   obstacleProofHash:occupancy.hash,boundaryProofHash:sourceHash,scopeProofHash:sourceHash,completeScene:true,
   readingOrder:'proven',whitespace:'source-codes',structure:'body-text',columnBoundary:'proven',semantics:'plain',inlineFeatures:'plain-prose',
   crop,clip:media,obstacles:[]}} satisfies import('./regionProof').ParagraphInput;
   const beforeFirst=trace.ends.get(input.lines[0]!.anchor.opIndex-1);
   const result=count>=3?detectParagraphRegion(input,beforeFirst):shortStreamRegionResult(input,beforeFirst);
   if(result.ok){chosen={proof:result.proof,start,end};break;}
   failures.push({start,count,failure:result});
  }
  if(!chosen){
   const primary=failures.find(f=>f.failure.blocker==='operators')??failures[0]!;
   return refuse('region-unproved',`lines=${lines.length} targetLine=${targetLine} obstacles=${obstacles.length} | `+
    failures.map(f=>`${f.count}@${f.start}:${f.failure.blocker}:${f.failure.detail}`).join('; '),primary.failure.blocker);
  }
  proof={...chosen.proof,occupancyHash:occupancy.hash};
  lines=lines.slice(chosen.start,chosen.end);
  source=source.filter(t=>t.original!.line>=chosen.start&&t.original!.line<chosen.end).map(t=>({...t,original:{...t.original!,line:t.original!.line-chosen.start}}));
 }
 // This is only the old-ink bound. The authorized mask is fixed from
 // changed old/new ink after layout and before the compiler sees the plan.
 const mask=source.flatMap(t=>t.ink.w>0&&t.ink.h>0?[{x:t.original!.x+t.ink.x-occupancy.guardPt,y:t.original!.y+t.ink.y-occupancy.guardPt,w:t.ink.w+2*occupancy.guardPt,h:t.ink.h+2*occupancy.guardPt}]:[]);
 proof={...proof,mask,box:boundBoxes(mask)};
 return {ok:true as const,ops,trace,walk,source,proof,lines,ink,crop,media,obstacles,occupancy,target,fonts};
}

/** Add ONE baseline only after its whole leading-height body band is clear.
 * The new box can only extend downward. No baseline, horizontal edge or
 * previously proved top may be moved to make an edit fit.
 */
export function proveDownwardSlot(e:StreamReflowEvidence,proof:RegionProof):RegionProof|null{
 if(proof.lineSlots.length>=8||!(proof.leadingPt>0))return null;
 const last=proof.lineSlots.at(-1)!,body=proof.lineSlots[1]??last,baseline=last.baseline-proof.leadingPt;
 const lower=Math.min(...e.source.map(t=>t.ink.y))-e.occupancy.guardPt,upper=Math.max(...e.source.map(t=>t.ink.y+t.ink.h))+e.occupancy.guardPt;
 // Keep the full leading-height floor. Only source placements in the
 // candidate are potentially vacated; every outsider remains an obstacle.
 const bottom=baseline+Math.min(lower,-.25*proof.leadingPt),top=baseline+Math.max(upper,.75*proof.leadingPt);
 const band={x:body.left,y:bottom,w:body.right-body.left,h:top-bottom};
 const candidate=new Set(e.source.map(t=>glyphKey(t.source!)));
 if(!contains(e.crop,band)||!contains(e.media,band)||queryOccupancy(e.occupancy,band).some(o=>!o.owner||!candidate.has(o.owner)))return null;
 const box={...proof.box,y:Math.min(proof.box.y,bottom),h:proof.box.y+proof.box.h-Math.min(proof.box.y,bottom)};
 return {...proof,box,lineSlots:[...proof.lineSlots,{left:body.left,right:body.right,baseline,kind:'explicit-blank'}],
  obstacleProofHash:`${proof.obstacleProofHash}:empty-band:${baseline}`};
}
