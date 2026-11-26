import {PDFDict,PDFDocument,PDFName,PDFObjectCopier,PDFPage} from 'pdf-lib';
import type {ContentTextOverlay,PdfRect} from '../../model/types';
import type {ContentTextOutcome} from './outcomes';
import {annotationAnchorRefusal,retypesetAffectedBoxes,type AnchoredAnnotation} from '../sourceAnnotationAnchors';
import type {SubstituteOptions} from '../contentStreamEdit/substitute';
import type {ResolvedRunFont} from '../contentStreamEdit/replaceRun';
import {inspectRunPage,runPageEnvironment} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {walkTextPlacements} from '../contentStreamEdit/textState';
import {substitutionStamp} from '../contentStreamEdit/substituteSnapshot';
import {encodeRun,codes} from '../contentStreamEdit/runEncoding';
import {runContextSafety} from '../contentStreamEdit/replaceRun';
import {address,readRetypesetSource} from './retypesetSource';
import {selectRetypeset} from './retypesetPlan';
import {verifyRetypesetGlyphs} from './retypesetVerify';
import {retypesetScopes} from './retypesetScopes';
import {reflowScene} from './reflowScene';
import {bounds} from './retypesetInk';
import {columnInk} from './uprightColumnInk';
import {contains,intersects} from './regionProof/geometry';
import {columnCells,planUprightColumn,uprightColumnSelection,uprightScale,type ColumnCell} from './uprightColumnPlan';
import {attachRiders,planUprightFlow,type FlowPlan} from './uprightColumnFlow';
import {chooseUprightGlyphs,columnObservations} from './uprightColumnGlyphs';
import {blankActualText,singleGlyphActualText} from './uprightColumnActualText';
import {columnCellEdits,columnEvidence} from './uprightColumnEvidence';
import {emitColumn,type ColumnAtom} from './uprightColumnEmit';
import {tcyAtoms,tcyEvidence} from './uprightColumnTcy';
import {interleavedColumnEdit} from './uprightColumnStray';
import {shortColumnEdit} from './uprightColumnShort';
import {retypesetFontGroups} from './retypesetFontGroups';
import {retainColumnOwners} from './uprightColumnOwnership';
import {fittedUprightColumns} from './uprightColumnFit';

const refusal=(e:ContentTextOverlay,detail:unknown):ContentTextOutcome=>({overlayId:e.id,mode:'unsupported',reason:'unsupported-vertical-writing',detail:String(detail)});

/** Upright columns shown by horizontal-mode fonts, one placed glyph per
 * cell. Each edit owns exactly its selected cells; every output glyph is an
 * upright single scalar at a source cell (or the observed pitch below the
 * last one), centred on the column. A final spacing retry keeps the first
 * row and font size, with at least 0.8 em and separated ink between rows,
 * then retries uniformly down to 85% size under the same destination proof.
 * New ink may extend past the selection
 * only into space proved empty of all other ink and paint, inside the page
 * and its clip, as the horizontal writer does. One edit compiles per fresh
 * source read. */
export async function applyUprightColumnRetypesets(page:PDFPage,edits:readonly ContentTextOverlay[],outcomes:Map<string,ContentTextOutcome>,accepted:Set<string>,options:SubstituteOptions,anchors:readonly AnchoredAnnotation[]=[]){
 const handled=new Set<string>();
 for(const edit of edits){
  if(accepted.has(edit.id))continue;
  const content=inspectRunPage(page);if(!content.ok)return handled;
  const ops=tokenizeContentStream(content.bytes),read=readRetypesetSource(page,ops,options.stage5Type1,undefined,{flippedType3:true});
  if(!read.walk.ok||read.verticalFonts.size)return handled;
  // A one-glyph ActualText span is that glyph's extracted text.
  const labels=singleGlyphActualText(ops,read.glyphs),source={...read,glyphs:read.glyphs.map(g=>{const l=labels.get(address(g.glyph));return l?{...g,text:l.text}:g;})};
  // Column cells may hold ink away from their advance box (a vertical comma
  // sits top-right); a glyph whose proved ink lies inside a cover is selected.
  const picked=new Set(selectRetypeset(source.glyphs,edit));
  // Cheap gate first: horizontal selections never stack, so they skip ink.
  // Interleaved overlays need only one column of three stacked cells here; a
  // short column (one column picked, two or more characters asked for) goes
  // on to the page-grid proof.
  const gate=columnCells([...picked],source.fonts);
  if(!gate?.some(k=>k.length>=3)&&!(gate?.length===1&&Array.from(edit.originalText.replace(/\s/gu,'')).length>=2))continue;
  const ink=columnInk(page,source.fonts,ops);
  for(const g of source.glyphs)if(!picked.has(g)&&edit.coverRects.some(r=>intersects(r,bounds(g.glyph.quad)))){const i=ink(source.fonts.find(f=>f.resourceName===g.glyph.fontName)!,g.glyph.code,g.state,g.x,g.y);if(i.known&&i.box.w>0&&edit.coverRects.some(r=>contains(r,i.box)))picked.add(g);}
  const hits=source.glyphs.filter(g=>picked.has(g));
  let addressed=edit,selection=uprightColumnSelection(source.glyphs,hits,source.fonts,edit);
  // Cells of staggered neighbour columns that the edit leaves are left in place.
  if(!selection){const one=interleavedColumnEdit(hits,source.fonts,edit);if(one){addressed=one.edit;selection=uprightColumnSelection(source.glyphs,one.hits,source.fonts,addressed);}}
  // A whole short column, or one split into overlay rows, needs the page grid.
  if(!selection){const short=shortColumnEdit(source.glyphs,hits,source.fonts,edit);if(short)({edit:addressed,selection}=short);}
  if(!selection)continue;
  handled.add(edit.id);
  try{
   const prior=outcomes.get(edit.id)?.reason;
   if(prior==='ambiguous-match')throw Error('vertical-source: ambiguous selection');
   if(prior==='stale-source')throw Error('vertical-source: stale source revision');
   if(source.walk.ok&&source.walk.unplacedText)throw Error('vertical-source: unplaced source text');
   // A clip refusal tries a one-column fit before flowing into a proved-empty
   // next column inside that clip. Other growth tries flow before fit. Keep
   // the cell refusal and both retry details when all three plans fail.
   let manifest;
   try{manifest=await compileColumn(page,content,ops,source,selection,addressed,options,labels,'cells');}
   catch(error){if(!/^vertical-(obstacle|crop-media|clip):/u.test((error as Error).message))throw error;
    let detail=(error as Error).message;
    const retries=detail.startsWith('vertical-clip:')?['fit','flow']as const:['flow','fit']as const;
    for(const mode of retries)try{manifest=await compileColumn(page,content,ops,source,selection,addressed,options,labels,mode);break;}catch(retry){detail+=`; ${mode}: ${(retry as Error).message}`;}
    if(!manifest)throw Error(detail);}
   const anchor=annotationAnchorRefusal(anchors,retypesetAffectedBoxes(manifest.geometry));
   if(anchor){outcomes.set(edit.id,{overlayId:edit.id,mode:'unsupported',...anchor});continue;}
   manifest.install();
   accepted.add(edit.id);
   const {cells,strippedEquivalent,...retypeset}=manifest.geometry,outcome:ContentTextOutcome={overlayId:edit.id,mode:'retypeset',fidelity:'approximate',
    ...(strippedEquivalent?{strippedEquivalent}:{}),retypeset:{...retypeset,reason:prior??'unsupported-vertical-writing'}};
   columnEvidence.set(outcome,cells);
   outcomes.set(edit.id,outcome);
  }catch(error){outcomes.set(edit.id,refusal(edit,error));}
 }
 return handled;
}

async function compileColumn(page:PDFPage,content:{bytes:Uint8Array;sourceHash:string},ops:ReturnType<typeof tokenizeContentStream>,source:ReturnType<typeof readRetypesetSource>,selection:NonNullable<ReturnType<typeof uprightColumnSelection>>,edit:ContentTextOverlay,options:SubstituteOptions,labels:ReturnType<typeof singleGlyphActualText>,mode:'cells'|'flow'|'fit'){
 const flow=mode==='flow',fit=mode==='fit';
 const fonts=[...source.fonts];
 const allCells=source.glyphs.flatMap(g=>{const font=fonts.find(f=>f.resourceName===g.glyph.fontName),s=uprightScale(g.state);if(!font||!s)return[];const width=font.widthOf(g.glyph.code)*g.state.fontSize/1000*s.x;return Number.isFinite(width)?[{glyph:g,font,cx:g.x+width/2,em:g.state.fontSize*s.y,width} satisfies ColumnCell]:[];});
 const base=planUprightColumn(selection,edit),plan:FlowPlan=flow?planUprightFlow(selection,edit,base,allCells):{...base,moved:[],wrapped:[]};
 if(fit&&(selection.columns.length!==1||edit.text.includes('\n')||base.owned.some(c=>Math.abs(c.em-selection.em)>.05)))throw Error('vertical-layout: spacing retry requires one size and column without explicit breaks');
 const owned=plan.owned.map(c=>c.glyph);
 if(owned.some(g=>!g.text))throw Error('vertical-source: unlabelled column glyph');
 const stamp=substitutionStamp(page),scratch=await PDFDocument.create();
 const faces=page.node.Resources()?.lookupMaybe(PDFName.of('Font'),PDFDict);
 // Subsets of one face share a BaseFont (Type3: descriptor FontName) after the subset tag.
 const family=(f:ResolvedRunFont)=>{const raw=faces?.lookupMaybe(PDFName.of(f.resourceName),PDFDict);return(raw?.lookupMaybe(PDFName.of('BaseFont'),PDFName)??raw?.lookupMaybe(PDFName.of('FontDescriptor'),PDFDict)?.lookupMaybe(PDFName.of('FontName'),PDFName))?.decodeText().replace(/^[A-Z]{6}\+/u,'');};
 const items=plan.placed.map(p=>({text:p.text,home:p.slot.home,font:p.slot.font}));
 const context=[...selection.members.values()].flat().map(c=>c.glyph.text??'').join('')+edit.text;
 const groups=retypesetFontGroups(page,ops,scratch,fonts,options,'vertical','ShioriVc');
 const choices=await chooseUprightGlyphs(items,columnObservations(allCells),font=>{const face=family(font);return face?fonts.filter(f=>family(f)===face):[];},options);
 const substitute=await groups.fill(items.filter((_,i)=>'fallback' in choices[i]!),context);
 const prepared=groups.prepared;
 // Measurement resources include the private substitute; nothing installs yet.
 const original=page.node.Resources(),fontDict=original?.lookupMaybe(PDFName.of('Font'),PDFDict),measureNode=page.node.clone();
 const measureResources=original?.clone()??page.doc.context.obj({}),measureFonts=fontDict?.clone()??page.doc.context.obj({});
 for(const {p}of prepared)measureFonts.set(PDFName.of(p.resolved.resourceName),scratch.context.lookup(p.ref)!);
 measureResources.set(PDFName.of('Font'),measureFonts);measureNode.set(PDFName.of('Resources'),measureResources);
 const ink=columnInk(PDFPage.of(measureNode,page.ref,page.doc),fonts,ops);
 if(flow){
  const ownedSet=new Set([...owned,...plan.moved.map(m=>m.cell.glyph)]),bottom=Math.min(...plan.owned.map(c=>ink(c.font,c.glyph.glyph.code,c.glyph.state,c.glyph.x,c.glyph.y).box.y));
  const riders=source.glyphs.filter(g=>!ownedSet.has(g)).flatMap(g=>{const font=fonts.find(f=>f.resourceName===g.glyph.fontName),i=font&&ink(font,g.glyph.code,g.state,g.x,g.y);return font&&i?.known?[{cell:{glyph:g,font,cx:NaN,em:NaN,width:NaN},box:i.box}]:[];});
  plan.moved.push(...attachRiders(plan,riders,bottom));
 }
 const moving=plan.moved.map(m=>m.cell.glyph),target=new Set([...owned,...moving].map(g=>address(g.glyph)));
 if(moving.some(g=>!g.text))throw Error('vertical-source: unlabelled column glyph');
 const tcy=tcyEvidence(allCells);
 const rows:ColumnAtom[][]=plan.placed.map((p,i)=>{
  const choice=choices[i]!,s=p.slot.home.state;
  if('tcy' in choice)return tcyAtoms(p.text,p.slot,tcy,ink);
  let font:ResolvedRunFont,bytes:Uint8Array;
  if('fallback' in choice){const chosen=substitute.get(items[i]!);if(!chosen)throw Error(`vertical-glyph: no substitute face covers ${JSON.stringify(p.text)}`);font=chosen;const e=encodeRun(p.text,font,new Uint8Array());if(!e.ok)throw Error('vertical-glyph: substitute cannot encode');bytes=e.bytes;}
  else({font,bytes}=choice);
  const list=codes(bytes,font.bytesPerCode);if(list.length!==1)throw Error('vertical-glyph: output is not one glyph per cell');
  const code=list[0]!,scale=uprightScale(s)!,width=font.widthOf(code)*s.fontSize/1000*scale.x;
  if(!Number.isFinite(width))throw Error('vertical-metrics: unmeasurable output advance');
  const origin={x:p.slot.cx-width/2,y:p.slot.y},measured=ink(font,code,s,origin.x,origin.y);
  if(!measured.known)throw Error('vertical-glyph: output ink is unproved');
  return[{text:p.text,font,bytes,code,home:p.slot.home,origin,box:measured.box}];
 });
 let atoms=rows.flat();
 // Moved cells keep font, code and state; only their origin translates.
 for(const {cell:c,dx,dy}of plan.moved){
  const g=c.glyph,origin={x:g.x+dx,y:g.y+dy},measured=ink(c.font,g.glyph.code,g.state,origin.x,origin.y);
  if(!measured.known)throw Error('vertical-glyph: moved ink is unproved');
  atoms.push({text:g.text!,font:c.font,bytes:c.font.bytesPerCode===1?Uint8Array.of(g.glyph.code):Uint8Array.of(g.glyph.code>>8,g.glyph.code&255),code:g.glyph.code,home:g,origin,box:measured.box});
 }
 const media=page.getMediaBox(),crop=page.getCropBox(),pageBox={x:Math.max(media.x,crop.x),y:Math.max(media.y,crop.y),w:0,h:0};
 pageBox.w=Math.min(media.x+media.width,crop.x+crop.width)-pageBox.x;pageBox.h=Math.min(media.y+media.height,crop.y+crop.height)-pageBox.y;
 const scene:PdfRect[]=[];reflowScene(page,ops,pageBox,(box,kind)=>{if(kind!=='backdrop')scene.push(box);},.02);
 const fixed=source.glyphs.filter(g=>!target.has(address(g.glyph))).map(g=>ink(fonts.find(f=>f.resourceName===g.glyph.fontName)!,g.glyph.code,g.state,g.x,g.y));
 const ownedInk=owned.map(g=>ink(fonts.find(f=>f.resourceName===g.glyph.fontName)!,g.glyph.code,g.state,g.x,g.y));
 const scopes=retypesetScopes(ops);
 if(ownedInk.some(i=>!i.known))throw Error('vertical-source: unproved column ink');
 for(const [i,g]of owned.entries()){
  if(!edit.coverRects.some(r=>contains(r,ownedInk[i]!.box)))throw Error('vertical-source: partially covered column glyph');
  const clip=scopes.get(g.glyph.opIndex)?.clip;if(clip===null||clip&&!contains(clip,ownedInk[i]!.box))throw Error('vertical-clip: source ink is not wholly inside a proved clip');
 }
 const prove=(list:ColumnAtom[])=>{
 for(const a of list){
  if(!contains(pageBox,a.box))throw Error('vertical-crop-media: destination ink leaves page bounds');
  if(fit&&!contains(pageBox,{...a.origin,w:0,h:0}))throw Error('vertical-crop-media: destination text origin leaves page bounds');
  const clip=scopes.get(a.home.glyph.opIndex)?.clip;if(clip===null||clip&&!contains(clip,a.box))throw Error('vertical-clip: destination ink escapes its source clip');
  const blocking=fixed.find(f=>f.box.w>0&&f.box.h>0&&intersects(f.box,a.box));
  if(blocking)throw Error(blocking.known?'vertical-obstacle: destination overlaps unpushed ink; a following-column push is unproved':'vertical-source: unproved stationary ink');
  if(scene.some(o=>intersects(o,a.box)))throw Error('vertical-obstacle: destination overlaps page paint');
 }
 // A wrapped column must be empty of every non-moving ink and paint over its
 // whole band, not only at the cells this edit fills.
 for(const w of plan.wrapped){
  if(!contains(pageBox,w.band))throw Error('vertical-crop-media: wrapped column leaves page bounds');
  if(fixed.some(f=>intersects(f.box,w.band))||scene.some(o=>intersects(o,w.band)))throw Error('vertical-obstacle: wrapped column is not empty');
 }
 if(list.some((a,i)=>list.slice(i+1).some(b=>intersects(a.box,b.box))))throw Error('vertical-glyph: output ink overlaps');
 if(fit){
  const cx=selection.columns[0]![0]!.cx,em=selection.em;
  const band=bounds([{x:cx-em/2,y:list[0]!.origin.y},{x:cx+em/2,y:list[0]!.origin.y},...list.flatMap(a=>[a.origin,{x:a.box.x,y:a.box.y},{x:a.box.x+a.box.w,y:a.box.y+a.box.h}])]);
  if(!contains(pageBox,band))throw Error('vertical-crop-media: fitted column band leaves page bounds');
  if(fixed.some(f=>intersects(f.box,band))||scene.some(o=>intersects(o,band)))throw Error('vertical-obstacle: fitted column band is not empty');
 }
 };
 if(fit){
  let fitted:ColumnAtom[]|undefined,last:unknown=Error('vertical-layout: no tighter non-overlapping spacing');
  for(const trial of fittedUprightColumns(rows,plan.placed.map(p=>p.slot),selection.em,plan.step,ink)){
   try{prove(trial);fitted=trial;break;}catch(error){last=error;}
  }
  if(!fitted)throw last;atoms=fitted;
 }else prove(atoms);
 // Only the proved per-cell entries can be ignored by the writer's safety walk.
 const blanked=blankActualText(content.bytes,[...owned,...moving].flatMap(g=>{const l=labels.get(address(g.glyph));return l?[l.span.extent]:[];})),blankedOps=tokenizeContentStream(blanked);
 if(blankedOps.length!==ops.length)throw Error('vertical-source: ActualText rewrite changed the operator sequence');
 const env=runPageEnvironment(page),unclipped=blankedOps.map(o=>['W','W*'].includes(o.operator)?{...o,operator:'n',operands:[]}:o),safety=runContextSafety(unclipped,env);
 if(!safety.ok||[...owned,...moving].some(g=>safety.unsafe.has(g.glyph.opIndex)))throw Error('vertical-source: graphics or semantic dependency');
 atoms=retainColumnOwners(owned,rows,atoms,ops,env,scopes);
 const {compiled,equivalents,strippedEquivalent}=emitColumn(page,content.bytes,ops,source,[...owned,...moving],atoms,fonts,labels);
 const after=walkTextPlacements(tokenizeContentStream(compiled),{...source.callbacks,resolveFont:name=>{const f=fonts.find(f=>f.resourceName===name);return f&&!source.fonts.includes(f)?{...f,ok:true as const,appliesWordSpacing:f.bytesPerCode===1}:source.callbacks.resolveFont(name);}});
 if(!after.ok||after.unplacedText)throw Error('vertical-source: compiled placements are unproved');
 verifyRetypesetGlyphs(after.glyphs,source.glyphs.filter(g=>!target.has(address(g.glyph))).map(g=>g.glyph),atoms.map(a=>({fontName:a.font.resourceName,code:a.code,point:a.origin})));
 const current=inspectRunPage(page);
 if(!current.ok||current.sourceHash!==content.sourceHash||substitutionStamp(page)!==stamp||page.node.Resources()!==original)throw Error('vertical-source: page changed during font preparation');

 const cells=columnCellEdits(owned,moving,atoms,equivalents);
 const paragraphBox=bounds([...owned.flatMap(g=>g.glyph.quad),...atoms.map(a=>a.origin),...[...ownedInk,...atoms].flatMap(a=>[{x:a.box.x,y:a.box.y},{x:a.box.x+a.box.w,y:a.box.y+a.box.h}])]);
 const geometry={paragraphBox,cells,strippedEquivalent,substituteFont:prepared.length?[...new Set(prepared.map(p=>p.name))].join(', '):null,lineCount:plan.columns,overflowed:plan.overflowed,pushed:plan.moved.length>0,pushedDeltaPt:Math.max(0,...plan.moved.map(m=>Math.hypot(m.dx,m.dy))),pushedRegions:movedRegions(plan,ink),overflowInkOverlap:false,unchangedLineDriftPt:0,quality:{maxUnchangedLineStartXDriftPt:0,maxUnchangedLineBaselineDriftPt:0,overflowInkOverlap:false}};
 return {geometry,install(){
  const resources=original?.clone()??page.doc.context.obj({}),installed=fontDict?.clone()??page.doc.context.obj({});
  const copier=PDFObjectCopier.for(scratch.context,page.doc.context);for(const {p}of prepared)installed.set(PDFName.of(p.resolved.resourceName),copier.copy(p.ref));
  resources.set(PDFName.of('Font'),installed);page.node.set(PDFName.of('Resources'),resources);
  page.node.set(PDFName.of('Contents'),page.doc.context.register(page.doc.context.flateStream(compiled)));
 }};
}

/** One authorized translation per destination column of moved cells. */
function movedRegions(plan:FlowPlan,ink:ReturnType<typeof columnInk>){
 return [...new Set(plan.moved.map(m=>m.group))].map(group=>{
  const list=plan.moved.filter(m=>m.group===group),{dx,dy}=list[0]!;
  const before=bounds(list.flatMap(({cell:c})=>{const g=c.glyph,b=ink(c.font,g.glyph.code,g.state,g.x,g.y).box;return[...g.glyph.quad,{x:b.x,y:b.y},{x:b.x+b.w,y:b.y+b.h}];}));
  return{before,after:{...before,x:before.x+dx,y:before.y+dy}};
 });
}
