import type {PDFPage} from 'pdf-lib';
import {sourceFingerprint,type ResolvedRunFont} from '../contentStreamEdit/replaceRun';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {walkTextPlacements} from '../contentStreamEdit/textState';
import {runResourceStamp} from '../contentStreamEdit/resourceStamp';
import type {Type1Options} from '../fontCoverage/type1Support';
import {detectParagraphRegion,type ParagraphLine,type RegionProof,type Rect,type SourceAddress} from './regionProof';
import {compatible,contains,intersects,origin,physicalLeading,physicalSize,validTrace} from './regionProof/geometry';
import {traceReflowSource} from './reflowTrace';
import {streamInkResolver} from './reflowInk';
import type {ReflowCodeCluster} from './reflowTypes';
export const unionReflowBoxes=(boxes:readonly Rect[]):Rect=>{
 const x=Math.min(...boxes.map(b=>b.x)),y=Math.min(...boxes.map(b=>b.y));
 return {x,y,w:Math.max(...boxes.map(b=>b.x+b.w))-x,h:Math.max(...boxes.map(b=>b.y+b.h))-y};
};
const pageRect=(r:{x:number;y:number;width:number;height:number}):Rect=>({x:r.x,y:r.y,w:r.width,h:r.height});
/** A complete, deliberately bounded scene walk. Unknown paint is not empty
 * space: forms/images, paths, clipping, graphics effects, semantic spans and
 * annotations refuse this automatic proof. Text in any other BT is included
 * as an obstacle, even if it lies outside the current selection.
 */
export function streamReflowEvidence(page:PDFPage,content:Uint8Array,fonts:readonly ResolvedRunFont[],targetOp:number,options:Type1Options={}){
 const ops=tokenizeContentStream(content),sourceHash=sourceFingerprint(content),dependencyHash=runResourceStamp(page);
 const allowed=new Set(['q','Q','cm','BT','ET','Tf','Tm','Td','TD','T*','Tc','Tw','Tz','TL','Ts','Tr','Tj','TJ','rg','RG','g','G','k','K']);
 if(ops.some(o=>!allowed.has(o.operator))||page.node.Annots()?.size())return null;
 const trace=traceReflowSource(ops,fonts,sourceHash),byName=new Map(fonts.map(f=>[f.resourceName,f]));
 const resolveFont=(name:string)=>{const f=byName.get(name);return f?{...f,ok:true as const,appliesWordSpacing:f.bytesPerCode===1}:null;};
 const walk=walkTextPlacements(ops,{resolveFont});if(!walk.ok||walk.unplacedText||walk.glyphs.length>16384)return null;
 const ink=streamInkResolver(page,fonts,options),target=[...trace.shows.values()].find(s=>s.before.opIndex===targetOp)?.before;
 if(!target||!validTrace(target))return null;
 let lines:ParagraphLine[]=[],source:ReflowCodeCluster[]=[];
 const obstacles:Rect[]=[];
 for(const g of walk.glyphs){
  const show=trace.shows.get(`${g.opIndex}:${g.arrayItemIndex}`),font=byName.get(g.fontName);
  if(!show||!font)return null;
  const measured=ink(g.fontName,g.code,show.before),unicode=font.unicodeByCode.get(g.code);
  // Unknown text ink or advance anywhere prevents a complete scene proof.
  if(!measured||!unicode||/[\r\n\t\uFFFD]/u.test(unicode))return null;
  const o=g.coreQuad[0],box={...measured.box,x:o.x+measured.box.x,y:o.y+measured.box.y};
  if(show.before.bt!==target.bt||!compatible(show.before,target)||!compatible(show.after,target)){
   // Real whitespace still occupies a text placement for downward clearance.
   obstacles.push(unionReflowBoxes([box,{x:o.x,y:o.y-.2*physicalSize(show.before),w:g.coreQuad[1].x-o.x,h:physicalSize(show.before)}]));continue;
  }
  const address:SourceAddress={streamHash:sourceHash,opIndex:g.opIndex,itemIndex:g.arrayItemIndex,byteStart:g.byteOffset,byteEnd:g.byteOffset+g.byteLength,fontObject:font.objectId};
  let line=lines.at(-1);
  if(!line||Math.abs(origin(line.shows[0]!.before)[1]-o.y)>.01){
   const anchor=[...trace.anchors.values()].findLast(t=>t.opIndex<g.opIndex&&t.bt===target.bt);
   if(!anchor||!validTrace(anchor))return null;
   line={anchor,shows:[],ink:null};lines.push(line);
  }
  if(!line.shows.some(s=>s.source.opIndex===g.opIndex&&s.source.itemIndex===g.arrayItemIndex)){
   const op=ops[g.opIndex]!,item=op.operator==='TJ'&&op.operands[0]?.kind==='array'?op.operands[0].items[g.arrayItemIndex]:op.operands[0];
   if(item?.kind!=='string')return null;
   line.shows.push({source:{...address,byteStart:0,byteEnd:item.bytes.length},unicode:'',...show});
  }
  line.shows.at(-1)!.unicode+=unicode;line.ink=line.ink?unionReflowBoxes([line.ink,box]):box;
  const advance=g.coreQuad[1].x-o.x;if(!(advance>0))return null;
  source.push({unicode,advance,ink:measured.box,em:physicalSize(show.before),wordSpace:font.bytesPerCode===1&&g.code===32,
   fullEmHan:font.widthOf(g.code)===1000,gap:0,original:{line:lines.length-1,x:o.x,y:o.y},source:address,glyph:measured.glyph,
   code:font.bytesPerCode===1?Uint8Array.of(g.code):Uint8Array.of(g.code>>8,g.code&255),fontResource:font.resourceName,fontObject:font.objectId});
 }
 if(!lines.length||source.length>4096||lines.length>128)return null;
 for(let i=0;i<source.length-1;i++)if(source[i]!.original!.line===source[i+1]!.original!.line)
  source[i]!.gap=source[i+1]!.original!.x-source[i]!.original!.x-source[i]!.advance;
 const crop=pageRect(page.getCropBox()),media=pageRect(page.getMediaBox());
 let proof:RegionProof;
 if(lines.length>=3){
  const targetLine=source.find(t=>t.source!.opIndex===targetOp)!.original!.line;
  // A BT can contain several paragraphs. Try bounded consecutive tails from
  // longest to shortest; every excluded placement becomes an obstacle. The
  // detector still proves all anchors/items in the chosen operator window.
  let chosen:{proof:RegionProof;start:number;end:number;outside:Rect[]}|undefined;
  for(let count=Math.min(lines.length,8);count>=3&&!chosen;count--)for(let start=Math.max(0,targetLine-count+1);start<=targetLine&&start+count<=lines.length;start++){
   const end=start+count,outside=source.filter(t=>t.original!.line<start||t.original!.line>=end).map(t=>({
    x:t.original!.x+Math.min(0,t.ink.x),y:t.original!.y+Math.min(-.2*t.em,t.ink.y),
    w:Math.max(t.advance,t.ink.x+t.ink.w)-Math.min(0,t.ink.x),h:Math.max(.8*t.em,t.ink.y+t.ink.h)-Math.min(-.2*t.em,t.ink.y)}));
   const result=detectParagraphRegion({sourceHash,dependencyHash,ops,lines:lines.slice(start,end),rasterGuardPt:.5,evidence:{sourceHash,dependencyHash,
   obstacleProofHash:dependencyHash,boundaryProofHash:sourceHash,scopeProofHash:sourceHash,completeScene:true,
   readingOrder:'proven',whitespace:'source-codes',structure:'body-text',columnBoundary:'proven',semantics:'plain',inlineFeatures:'plain-prose',
   crop,clip:media,obstacles:[...obstacles,...outside].map(box=>({kind:'text',box}))}});
   if(result.ok){chosen={proof:result.proof,start,end,outside};break;}
  }
  if(!chosen)return null;
  proof=chosen.proof;obstacles.push(...chosen.outside);
  lines=lines.slice(chosen.start,chosen.end);
  source=source.filter(t=>t.original!.line>=chosen.start&&t.original!.line<chosen.end).map(t=>({...t,original:{...t.original!,line:t.original!.line-chosen.start}}));
 }else{
  // An absolute single line proves only its ORIGINAL width. Explicit TL may
  // authorize a later downward slot after a separate empty-band proof.
  if(lines.length!==1||ops[lines[0]!.anchor.opIndex]?.operator!=='Tm')return null;
  const line=lines[0]!,first=line.shows[0]!,last=line.shows.at(-1)!;
  if(line.shows.length!==1)return null;
  const left=origin(first.before)[0],right=origin(last.after)[0],bounds=line.ink!;
  const box=unionReflowBoxes([bounds,{x:left,y:bounds.y-.5,w:right-left,h:bounds.h+1}]);
  if(!contains(crop,box)||!contains(media,box)||obstacles.some(b=>intersects(b,box)))return null;
  proof={kind:'explicit-line-region',sourceHash,dependencyHash,bt:target.bt,box,indent:{kind:'flush',amountPt:0},leadingPt:physicalLeading(target),
   lineSlots:[{left,right,baseline:origin(first.before)[1],kind:'observed'}],owned:line.shows.map(s=>s.source),tjBoundaries:[],
   obstacleProofHash:dependencyHash,boundaryProofHash:sourceHash,scopeProofHash:sourceHash};
 }
 // Reserve raster coverage now, before layout. This does not widen any line
 // slot and growth never changes these horizontal edges. A glyph on a body
 // left can otherwise change the antialiased pixel just outside its hull.
 const rasterBox={...proof.box,x:proof.box.x-.5,w:proof.box.w+1};
 if(!contains(crop,rasterBox)||!contains(media,rasterBox)||obstacles.some(b=>intersects(b,rasterBox)))return null;
 proof={...proof,box:rasterBox};
 return {ops,trace,walk,source,proof,lines,ink,crop,media,obstacles};
}
/** Add ONE baseline only after its whole leading-height body band is clear.
 * The new box can only extend downward. No baseline, horizontal edge or
 * previously proved top may be moved to make an edit fit.
 */
export function proveDownwardSlot(e:NonNullable<ReturnType<typeof streamReflowEvidence>>,proof:RegionProof):RegionProof|null{
 if(proof.lineSlots.length>=8||!(proof.leadingPt>0))return null;
 const last=proof.lineSlots.at(-1)!,body=proof.lineSlots[1]??last,baseline=last.baseline-proof.leadingPt;
 const lower=Math.min(...e.source.map(t=>t.ink.y))-.5,upper=Math.max(...e.source.map(t=>t.ink.y+t.ink.h))+.5;
 // Cover both the full leading-height band and conservative ink overhangs.
 const bottom=baseline+Math.min(lower,-.25*proof.leadingPt),top=baseline+Math.max(upper,.75*proof.leadingPt);
 const band={x:body.left,y:bottom,w:body.right-body.left,h:top-bottom};
 if(!contains(e.crop,band)||!contains(e.media,band)||e.obstacles.some(b=>intersects(b,band)))return null;
 const box={...proof.box,y:Math.min(proof.box.y,bottom),h:proof.box.y+proof.box.h-Math.min(proof.box.y,bottom)};
 if(!contains(e.crop,box)||!contains(e.media,box)||e.obstacles.some(b=>intersects(b,box)))return null;
 return {...proof,box,lineSlots:[...proof.lineSlots,{left:body.left,right:body.right,baseline,kind:'explicit-blank'}],
  obstacleProofHash:`${proof.obstacleProofHash}:empty-band:${baseline}`};
}
