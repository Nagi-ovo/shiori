import {PDFArray,PDFDict,PDFName,type PDFPage} from 'pdf-lib';
import {runContextSafety,sourceFingerprint,type ResolvedRunFont} from '../contentStreamEdit/replaceRun';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {walkTextPlacements,type UnplacedShow} from '../contentStreamEdit/textState';
import {textObjectScopes,followsUnplaced} from '../contentStreamEdit/textSafety';
import {runPageEnvironment} from '../contentStreamEdit/replaceRunPage';
import {runResourceStamp} from '../contentStreamEdit/resourceStamp';
import type {Type1Options} from '../fontCoverage/type1Support';
import {detectParagraphRegion,type ParagraphLine,type RegionProof,type Rect,type SourceAddress} from './regionProof';
import {paragraphMember,contains,intersects,origin,physicalSize,validTrace,linear} from './regionProof/geometry';
import {traceReflowSource} from './reflowTrace';
import {streamInkResolver} from './reflowInk';
import type {ReflowCodeCluster} from './reflowTypes';
import {reflowScene,numericArray} from './reflowScene';
import {shortStreamRegion} from './reflowShortRegion';
import {fontInputFromDict} from '../fontCoverage/pdfLibAdapter';
import {isCffProgram} from '../fontCoverage/cffHulls';
export const unionReflowBoxes=(boxes:readonly Rect[]):Rect=>{
 const x=Math.min(...boxes.map(b=>b.x)),y=Math.min(...boxes.map(b=>b.y));
 return {x,y,w:Math.max(...boxes.map(b=>b.x+b.w))-x,h:Math.max(...boxes.map(b=>b.y+b.h))-y};
};
const pageRect=(r:{x:number;y:number;width:number;height:number}):Rect=>({x:r.x,y:r.y,w:r.width,h:r.height});
/** Complete bounded scene proof. Paint and unrelated text are local obstacles;
 * missing bounds conservatively occupy the page, never grant empty space. */
export function streamReflowEvidence(page:PDFPage,content:Uint8Array,fonts:readonly ResolvedRunFont[],targetOp:number,options:Type1Options={},addressOnly=false){
 const ops=tokenizeContentStream(content),sourceHash=sourceFingerprint(content),dependencyHash=runResourceStamp(page);
 const environment=runPageEnvironment(page),unplaced:UnplacedShow[]=[],crop=pageRect(page.getCropBox()),media=pageRect(page.getMediaBox());
 const trace=traceReflowSource(ops,fonts,sourceHash,environment),byName=new Map(fonts.map(f=>[f.resourceName,f]));
 const anchors=[...trace.anchors.values()];
 const resolveFont=(name:string)=>{const f=byName.get(name);return f?{...f,ok:true as const,appliesWordSpacing:f.bytesPerCode===1}:{ok:false as const,reason:'unmeasurable source font'};};
 const walk=walkTextPlacements(ops,{resolveFont,extGStateSetsFont:name=>environment.extGStates?.get(name)?.setsFont??null,onUnplaced:s=>unplaced.push(s)});
 if(!walk.ok||walk.glyphs.length>16384||followsUnplaced(textObjectScopes(ops),unplaced.filter(s=>!s.advanceKnown).map(s=>s.opIndex),targetOp))return null;
 const safety=runContextSafety(ops,environment);if(!safety.ok)return null;
 const ink=streamInkResolver(page,fonts,options,addressOnly),target=[...trace.shows.values()].find(s=>s.before.opIndex===targetOp)?.before;
 if(!target||!validTrace(target))return null;
 let lines:ParagraphLine[]=[],source:ReflowCodeCluster[]=[];
 const obstacles:Rect[]=reflowScene(page,ops,media);
 const declaredBoxes=new Map<string,number[]|undefined>();
 const declaredBox=(name:string|undefined)=>{
  if(!name)return;
  if(declaredBoxes.has(name))return declaredBoxes.get(name);
  declaredBoxes.set(name,undefined);
  const raw=page.node.Resources()?.lookupMaybe(PDFName.of('Font'),PDFDict)?.lookupMaybe(PDFName.of(name),PDFDict);
  if(!raw)return;
  const matrix=numericArray(raw,'FontMatrix');
  if(matrix&&(matrix.length!==6||matrix.some((n,i)=>n!==[.001,0,0,.001,0,0][i])))return;
  const child=raw.lookupMaybe(PDFName.of('DescendantFonts'),PDFArray)?.lookup(0,PDFDict),descriptor=(child??raw).lookupMaybe(PDFName.of('FontDescriptor'),PDFDict);
  // An unmeasured CFF may require an unknown top/FD transform. Its /1000
  // declaration cannot grant scene clearance either.
  if(descriptor?.has(PDFName.of('FontFile3')))return;
  const input=fontInputFromDict(raw);
  if(input.program&&isCffProgram(input.program))return;
  const b=numericArray(raw,'FontBBox')??(descriptor?numericArray(descriptor,'FontBBox'):undefined);
  const result=b?.length===4&&b.every(Number.isFinite)&&b[2]!>b[0]!&&b[3]!>b[1]!?b:undefined;
  declaredBoxes.set(name,result);return result;
 };
 // A known origin plus a declared vertical envelope bounds an unknown
 // horizontal advance to a strip. Missing envelopes/rotation occupy the page.
 for(const s of unplaced){
  const t=trace.shows.get(`${s.opIndex}:${s.arrayItemIndex}`)?.before;
  const b=declaredBox(s.fontName),o=s.origin??(t?{x:origin({...t,tm:t.tlm})[0],y:origin({...t,tm:t.tlm})[1]}:undefined);
  if(o&&t&&b&&s.reason===undefined&&Number.isFinite(o.y)&&Math.abs(linear(t)[1]!)<1e-9&&Math.abs(linear(t)[2]!)<1e-9){
   const y1=o.y+b[1]!*s.fontSizePt/1000,y2=o.y+b[3]!*s.fontSizePt/1000;
   obstacles.push({x:media.x,y:Math.min(y1,y2)-.5,w:media.w,h:Math.abs(y2-y1)+1});
  }else obstacles.push(media);
 }
 for(const g of walk.glyphs){
  const show=trace.shows.get(`${g.opIndex}:${g.arrayItemIndex}`),font=byName.get(g.fontName);
  if(!show||!font)return null;
  const measured=ink(g.fontName,g.code,show.before),unicode=font.unicodeByCode.get(g.code);
  if(!measured){
   const bounds=declaredBox(g.fontName),t=show.before,[a,b,c,d]=linear(t),o=g.coreQuad[0];
   if(bounds){
    const points=[[bounds[0]!,bounds[1]!],[bounds[2]!,bounds[1]!],[bounds[2]!,bounds[3]!],[bounds[0]!,bounds[3]!]].map(([x,y])=>({
     x:o.x+(a!*x!*t.tz/100+c!*y!)*t.size/1000,y:o.y+(b!*x!*t.tz/100+d!*y!)*t.size/1000}));
    const left=Math.min(...points.map(p=>p.x))-.5,bottom=Math.min(...points.map(p=>p.y))-.5;
    obstacles.push({x:left,y:bottom,w:Math.max(...points.map(p=>p.x))+.5-left,h:Math.max(...points.map(p=>p.y))+.5-bottom});
   }else obstacles.push(media);
   continue;
  }
  const o=g.coreQuad[0],box={...measured.box,x:o.x+measured.box.x,y:o.y+measured.box.y};
  if(!unicode||/[\r\n\t\uFFFD]/u.test(unicode)||safety.unsafe.has(g.opIndex)||!paragraphMember(show.before,target)||!paragraphMember(show.after,target)){
   // Real whitespace still occupies a text placement for downward clearance.
   obstacles.push(unionReflowBoxes([box,{x:o.x,y:o.y-.2*physicalSize(show.before),w:g.coreQuad[1].x-o.x,h:physicalSize(show.before)}]));continue;
  }
  const address:SourceAddress={streamHash:sourceHash,opIndex:g.opIndex,itemIndex:g.arrayItemIndex,byteStart:g.byteOffset,byteEnd:g.byteOffset+g.byteLength,fontObject:font.objectId};
  let line=lines.at(-1);
  const anchor=anchors.findLast(t=>t.opIndex<g.opIndex&&t.bt===show.before.bt);
  if(!anchor||!validTrace(anchor))return null;
  const previous=line?.shows.at(-1),previousAnchor=line?.continuations?.at(-1)??line?.anchor;
  const continuation=previous&&anchor.opIndex!==previousAnchor?.opIndex;
  const gap=previous?o.x-origin(previous.after)[0]:0;
  // A new BT/Td may continue a word/space on the same baseline, but a distant
  // column is another row candidate, never whitespace capacity for this one.
  const separated=continuation&&(gap>Math.max(.5,.5*physicalSize(show.before))||gap<-.5);
  if(!line||Math.abs(origin(line.shows[0]!.before)[1]-o.y)>.01||separated){
   line={anchor,shows:[],ink:null};lines.push(line);
  }else if(anchor.opIndex!==line.anchor.opIndex&&!line.continuations?.some(t=>t.opIndex===anchor.opIndex)){
   (line.continuations??=[]).push(anchor);
  }
  if(!line.shows.some(s=>s.source.opIndex===g.opIndex&&s.source.itemIndex===g.arrayItemIndex)){
   const op=ops[g.opIndex]!,item=op.operator==='TJ'&&op.operands[0]?.kind==='array'?op.operands[0].items[g.arrayItemIndex]:op.operands[0];
   if(item?.kind!=='string')return null;
   line.shows.push({source:{...address,byteStart:0,byteEnd:item.bytes.length},unicode:'',...show});
  }
  line.shows.at(-1)!.unicode+=unicode;line.ink=line.ink?unionReflowBoxes([line.ink,box]):box;
  // coreQuad bounds the glyph's nominal width, excluding Tc/Tw. Paragraph
  // capacity needs its complete measured displacement, including the final
  // character/space of each show; gaps then contain only real positioning.
  const t=show.before,scale=linear(t)[0]!*t.tz/100;
  const advance=(font.widthOf(g.code)*t.size/1000+t.tc+(font.bytesPerCode===1&&g.code===32?t.tw:0))*scale;
  if(!(advance>0))return null;
  source.push({unicode,advance,metrics:{size:show.before.size,tc:show.before.tc,tw:show.before.tw},ink:measured.box,em:physicalSize(show.before),wordSpace:font.bytesPerCode===1&&g.code===32,
   fullEmHan:font.widthOf(g.code)===1000,gap:0,original:{line:lines.length-1,x:o.x,y:o.y},source:address,glyph:measured.glyph,
   code:font.bytesPerCode===1?Uint8Array.of(g.code):Uint8Array.of(g.code>>8,g.code&255),fontResource:font.resourceName,fontObject:font.objectId});
 }
 if(!lines.length)return null;
 for(let i=0;i<source.length-1;i++)if(source[i]!.original!.line===source[i+1]!.original!.line)
  source[i]!.gap=source[i+1]!.original!.x-source[i]!.original!.x-source[i]!.advance;
 let proof:RegionProof;
 {
  const targetLine=source.find(t=>t.source!.opIndex===targetOp)?.original?.line;if(targetLine===undefined)return null;
  // A BT can contain several paragraphs. Try bounded consecutive tails from
  // longest to shortest; every excluded placement becomes an obstacle. The
  // detector still proves all anchors/items in the chosen operator window.
  let chosen:{proof:RegionProof;start:number;end:number;outside:Rect[]}|undefined;
  for(let count=Math.min(lines.length,8);count>=1&&!chosen;count--)for(let start=Math.max(0,targetLine-count+1);start<=targetLine&&start+count<=lines.length;start++){
   const end=start+count,outside=source.filter(t=>t.original!.line<start||t.original!.line>=end).map(t=>({
    x:t.original!.x+Math.min(0,t.ink.x),y:t.original!.y+Math.min(-.2*t.em,t.ink.y),
    w:Math.max(t.advance,t.ink.x+t.ink.w)-Math.min(0,t.ink.x),h:Math.max(.8*t.em,t.ink.y+t.ink.h)-Math.min(-.2*t.em,t.ink.y)}));
   const input={sourceHash,dependencyHash,ops,lines:lines.slice(start,end),rasterGuardPt:.5,evidence:{sourceHash,dependencyHash,
   obstacleProofHash:dependencyHash,boundaryProofHash:sourceHash,scopeProofHash:sourceHash,completeScene:true,
   readingOrder:'proven',whitespace:'source-codes',structure:'body-text',columnBoundary:'proven',semantics:'plain',inlineFeatures:'plain-prose',
   crop,clip:media,obstacles:[...obstacles,...outside].map(box=>({kind:'text' as const,box}))}} satisfies import('./regionProof').ParagraphInput;
   const result=count>=3?detectParagraphRegion(input,trace.ends.get(input.lines[0]!.anchor.opIndex-1)):(()=>{const proof=shortStreamRegion(input,trace.ends.get(input.lines[0]!.anchor.opIndex-1));return proof?{ok:true as const,proof}:{ok:false as const};})();
   if(result.ok){chosen={proof:result.proof,start,end,outside};break;}
  }
  if(!chosen)return null;
  proof=chosen.proof;obstacles.push(...chosen.outside);
  lines=lines.slice(chosen.start,chosen.end);
  source=source.filter(t=>t.original!.line>=chosen.start&&t.original!.line<chosen.end).map(t=>({...t,original:{...t.original!,line:t.original!.line-chosen.start}}));
 }
 // Reserve raster coverage now, before layout. This does not widen any line
 // slot and growth never changes these horizontal edges. A glyph on a body
 // left can otherwise change the antialiased pixel just outside its hull.
 // Reserve the original font's vertical line envelope before layout as well
 // as its measured ink. A replacement face may have a taller x-height; this
 // grants no higher baseline and never expands the region during growth.
 const bottom=Math.min(proof.box.y,...source.map(t=>t.original!.y+byName.get(t.fontResource)!.descentEm*t.em-.5));
 const top=Math.max(proof.box.y+proof.box.h,...source.map(t=>t.original!.y+byName.get(t.fontResource)!.ascentEm*t.em+.5));
 const rasterBox={x:proof.box.x-.5,y:bottom,w:proof.box.w+1,h:top-bottom};
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
