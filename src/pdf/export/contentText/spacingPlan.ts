import {PDFDict,PDFName,PDFRef,type PDFPage} from 'pdf-lib';
import type {PageRunPlan} from '../contentStreamEdit/pageRunPlan';
import {sourceFingerprint as sourceHash,type ResolvedRunFont} from '../contentStreamEdit/replaceRun';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {walkTextPlacements} from '../contentStreamEdit/textState';
import {codes,encodeRun} from '../contentStreamEdit/runEncoding';
import {fontCoverageFromDict,fontInputFromDict} from '../fontCoverage/pdfLibAdapter';
import {readProgram} from '../fontCoverage/program';
import {runResourceStamp} from '../contentStreamEdit/resourceStamp';
import {traceReflowSource,ReflowTraceError} from './reflowTrace';
import {origin,validTrace,linear,physicalSize,contains,validRect} from './regionProof/geometry';
import type {Rect,RegionProof,SourceAddress} from './regionProof';
import type {ReflowCodeCluster} from './reflowTypes';
import {solveMeasuredReflow} from './reflowLayout';
const union=(boxes:Rect[]):Rect=>{const x=Math.min(...boxes.map(b=>b.x)),y=Math.min(...boxes.map(b=>b.y));return {x,y,w:Math.max(...boxes.map(b=>b.x+b.w))-x,h:Math.max(...boxes.map(b=>b.y+b.h))-y};};
const intersects=(a:Rect,b:Rect)=>a.x<b.x+b.w&&b.x<a.x+a.w&&a.y<b.y+b.h&&b.y<a.y+a.h;
/** Boolean-only recovery has NO paragraph authority. It may tighten a single
 * Tj replacement inside its original byte span. Conservative glyf control
 * bounds come from the embedded program; descriptor/core/selection boxes
 * never supply ink. Unknown paint, annotations, fonts or bounds refuse.
 */
export function planOriginalSlotSpacing(page:PDFPage,content:Uint8Array,fonts:readonly ResolvedRunFont[],fixed:PageRunPlan):PageRunPlan|null {
 if(fixed.edits.length!==1||fixed.reflow||fixed.reflows?.length)return null;
 const edit=fixed.edits[0]!;if(/[\r\n]/u.test(edit.replacement))return null;
 const ops=tokenizeContentStream(content),op=ops[edit.opIndex];
 if(op?.operator!=='Tj'||op.operands[0]?.kind!=='string'||edit.itemIndex!==-1)return null;
 // No unknown scene may be declared empty. This deliberately small text-only
 // subset includes neither semantic spans nor clips/transparency/images.
 const allowed=new Set(['q','Q','cm','BT','ET','Tf','Tm','Td','TD','T*','Tc','Tw','Tz','TL','Ts','Tr','Tj','TJ','rg','RG','g','G','k','K']);
 if(ops.some(o=>!allowed.has(o.operator))||page.node.Annots()?.size())return null;
 const scope=fixed.sourceHash,dependencyHash=runResourceStamp(page);
 try{
  const traces=traceReflowSource(ops,fonts,scope),show=traces.shows.get(`${edit.opIndex}:-1`);
  if(!show||!validTrace(show.before)||show.before.renderMode!==0)return null;
  const resolveFont=(name:string)=>{const f=fonts.find(f=>f.resourceName===name);return f?{...f,ok:true as const,appliesWordSpacing:f.bytesPerCode===1}:null;};
  const walked=walkTextPlacements(ops,{resolveFont});if(!walked.ok||walked.unplacedText||walked.glyphs.length>4096)return null;
  const byFont=new Map<string,{box:(code:number)=>Rect|undefined;identity:(code:number)=>{kind:'gid';programHash:string;gid:number}|undefined}>();
  const dict=page.node.Resources()?.lookupMaybe(PDFName.of('Font'),PDFDict);
  for(const font of fonts){
   const ref=dict?.get(PDFName.of(font.resourceName));if(!(ref instanceof PDFRef))return null;
   const raw=page.doc.context.lookup(ref,PDFDict),input=fontInputFromDict(raw);
   // Raw Type1 has verified widths, but its parser supplies no conservative
   // outline hull yet. Do not substitute FontBBox/ascent/descent estimates.
   if(input.error||!input.program||!(input.subtype==='TrueType'||input.subtype==='Type0'&&input.cidSubtype==='CIDFontType2'))return null;
   const program=readProgram(input),coverage=fontCoverageFromDict(raw);if(program.kind!=='fontkit'||program.cff)return null;
   const programHash=sourceHash(input.program);
   byFont.set(font.resourceName,{box:code=>{const gid=coverage.glyphIds.get(code.toString(16).padStart(font.bytesPerCode*2,'0'));if(!gid)return;
    const box=program.inkBox(gid);if(box&&validRect(box))return box;
    const text=font.unicodeByCode.get(code);if(text&&/^\p{White_Space}+$/u.test(text))return {x:0,y:0,w:0,h:0};
   },identity:code=>{const gid=coverage.glyphIds.get(code.toString(16).padStart(font.bytesPerCode*2,'0'));return gid?{kind:'gid',programHash,gid}:undefined;}});
  }
  const font=fonts.find(f=>f.resourceName===edit.fontResource&&f.objectId===edit.fontObject);if(!font)return null;
  const [sx,,,sy]=linear(show.before),scale=sx!*show.before.tz/100,size=show.before.size;
  const physicalInk=(name:string,code:number,state=show.before):Rect|undefined=>{
   const box=byFont.get(name)?.box(code);if(!box||!validTrace(state)||state.renderMode!==0)return;
   const [x,,,y]=linear(state),xs=x!*state.tz/100*state.size,ys=y!*state.size;
   return {x:box.x*xs,y:box.y*ys,w:box.w*xs,h:box.h*ys};
  };
  if(!(sx!>0&&sy!>0&&size>0))return null;
  const glyphs=walked.glyphs.filter(g=>g.opIndex===edit.opIndex);
  const source:ReflowCodeCluster[]=[];
  for(const g of glyphs){
   const ink=physicalInk(g.fontName,g.code),unicode=font.unicodeByCode.get(g.code),glyph=byFont.get(g.fontName)?.identity(g.code);
   if(!ink||!unicode||!glyph||Array.from(unicode).length!==1)return null;
   const address:SourceAddress={streamHash:fixed.sourceHash,opIndex:g.opIndex,itemIndex:-1,byteStart:g.byteOffset,byteEnd:g.byteOffset+g.byteLength,fontObject:font.objectId};
   source.push({unicode,code:op.operands[0].bytes.slice(address.byteStart,address.byteEnd),fontResource:font.resourceName,fontObject:font.objectId,source:address,glyph,
    advance:g.coreQuad[1].x-g.coreQuad[0].x,ink,em:physicalSize(show.before),wordSpace:font.bytesPerCode===1&&g.code===32,fullEmHan:font.widthOf(g.code)===1000,gap:0,original:{line:0,x:g.coreQuad[0].x,y:g.coreQuad[0].y}});
  }
  const start=source.findIndex(t=>t.source!.byteStart===edit.byteStart),last=source.findIndex(t=>t.source!.byteEnd===edit.byteEnd),end=last+1;
  if(start<0||last<start||source.some(t=>t.advance<=0))return null;
  if([...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(edit.replacement)].some(s=>Array.from(s.segment).length!==1))return null;
  const encoded=encodeRun(edit.replacement,font,edit.expected);if(!encoded.ok)return null;
  const replacement:ReflowCodeCluster[]=[];
  for(const [i,code]of codes(encoded.bytes,font.bytesPerCode).entries()){
   const unicode=font.unicodeByCode.get(code),ink=physicalInk(font.resourceName,code);if(!unicode||!ink||Array.from(unicode).length!==1)return null;
   replacement.push({...source[start]!,homeOp:edit.opIndex,unicode,ink,code:encoded.codes[i]!,source:undefined,glyph:undefined,original:undefined,
    advance:(font.widthOf(code)*size/1000+show.before.tc+(font.bytesPerCode===1&&code===32?show.before.tw:0))*scale,
    wordSpace:font.bytesPerCode===1&&code===32,fullEmHan:font.widthOf(code)===1000});
  }
  const boxes=source.map(t=>({...t.ink,x:t.original!.x+t.ink.x,y:t.original!.y+t.ink.y})),box=union(boxes);
  const first=origin(show.before),right=origin(show.after)[0];
  box.x=Math.min(box.x,first[0]);box.w=Math.max(...boxes.map(b=>b.x+b.w),right)-box.x;
  const crop=page.getCropBox(),media=page.getMediaBox();if(!contains({x:crop.x,y:crop.y,w:crop.width,h:crop.height},box)||!contains({x:media.x,y:media.y,w:media.width,h:media.height},box))return null;
  const proof:RegionProof={kind:'explicit-line-region',sourceHash:fixed.sourceHash,dependencyHash,bt:show.before.bt,box,
   indent:{kind:'flush',amountPt:0},leadingPt:0,lineSlots:[{left:first[0],right,baseline:first[1],kind:'observed'}],
   owned:[{...source[0]!.source!,byteStart:0,byteEnd:op.operands[0].bytes.length}],tjBoundaries:[],
   scopeProofHash:scope,boundaryProofHash:scope,obstacleProofHash:dependencyHash};
  const layout=solveMeasuredReflow({source,replacement,start,end,proof,softBreaks:[],allowSuffix:false,allowWrap:false});
  if(!layout.ok||layout.strategy!=='spacing-only')return null;
  // Respect an explicit fixed-span cap as well as the original source slot.
  if(edit.availablePt!==undefined&&replacement.reduce((n,t)=>n+t.advance,0)-layout.reductions.reduce((n,r)=>n+r,0)>edit.availablePt+1e-7)return null;
  const clusters=[...source.slice(0,start),...replacement,...source.slice(end)];
  const destinations=clusters.map((t,i)=>({...t.ink,x:layout.origins[i]![0]+t.ink.x,y:layout.origins[i]![1]+t.ink.y}));
  for(const g of walked.glyphs.filter(g=>g.opIndex!==edit.opIndex)){
   const state=traces.shows.get(`${g.opIndex}:${g.arrayItemIndex}`)?.before;if(!state)return null;
   const ink=physicalInk(g.fontName,g.code,state);if(!ink)return null;
   const obstacle={...ink,x:g.coreQuad[0].x+ink.x,y:g.coreQuad[0].y+ink.y};
   if(destinations.some(d=>intersects(d,obstacle)))return null;
  }
  return {...fixed,edits:[{...edit,byteStart:0,byteEnd:op.operands[0].bytes.length,expected:op.operands[0].bytes.slice(),replacement:''}],
   reflow:{proof,saved:show.before,clusters,layout,firstOp:edit.opIndex,lastOp:edit.opIndex,rejoin:show.after}};
 }catch(error){if(error instanceof ReflowTraceError||error instanceof Error&&!(error instanceof TypeError||error instanceof ReferenceError))return null;throw error;}
}
