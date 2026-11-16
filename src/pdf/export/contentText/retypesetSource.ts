import type {PDFPage} from 'pdf-lib';
import {PDFDict,PDFName,PDFRawStream} from 'pdf-lib';
import type {ContentOp} from '../contentStreamEdit/tokenizer';
import {walkTextPlacements,type ShowTextState} from '../contentStreamEdit/textState';
import {resolveRunFonts,runPageEnvironment} from '../contentStreamEdit/replaceRunPage';
import {substituteSourceFonts} from '../contentStreamEdit/substituteSource';
import type {Type1Options} from '../fontCoverage/type1Support';
import {buildVisualGroups} from './regionProof/visualGroups';
import type {ParagraphLine,TextTrace} from './regionProof';
import type {RetypesetGlyph,RetypesetGroup} from './retypesetTypes';
import type {TextGraphicsState} from '../contentStreamEdit/textGraphicsState';
import {verticalWritingReason} from '../contentStreamEdit/verticalWriting';

export const address=(g:RetypesetGlyph['glyph'])=>`${g.opIndex}:${g.arrayItemIndex}:${g.byteOffset}`;
/** Whole typographic displacement in the paragraph frame, including Tc/Tw/Tz.
 * The core quad's right edge need not coincide with the next glyph origin. */
export function retypesetAdvance(g:RetypesetGlyph,local:(x:number,y:number)=>{x:number;y:number}){
 const v=g.state.advanceVector;
 return local(v.x,v.y).x*g.glyph.tjCompensation*g.state.fontSize/1000;
}
/** Extra placement-only fonts never grant exact-tier encoding permission. */
export function readRetypesetSource(page:PDFPage,ops:ContentOp[],options:Type1Options={},initialState?:TextGraphicsState){
 const fonts=resolveRunFonts(page,options),extra=substituteSourceFonts(page);
 for(const f of extra)if(!fonts.some(a=>a.resourceName===f.resourceName))fonts.push(f);
 const states=new Map<string,ShowTextState>(),ends=new Map<number,{textMatrix:readonly number[];lineMatrix:readonly number[]}>(),environment=runPageEnvironment(page);
 const invocations=new Map<number,TextGraphicsState>();
 const verticalFonts=new Set<string>(),fontDict=page.node.Resources()?.lookupMaybe(PDFName.of('Font'),PDFDict);
 const callbacks={includeStroked:true,initialState,resolveFont:(name:string)=>{
  const dict=fontDict?.lookupMaybe(PDFName.of(name),PDFDict),vertical=dict?verticalWritingReason(dict):undefined;
  if(vertical){verticalFonts.add(`${name}: ${vertical}`);return {ok:false as const,reason:vertical};}
  const f=fonts.find(f=>f.resourceName===name);return f?{...f,ok:true as const,appliesWordSpacing:f.bytesPerCode===1}:{ok:false as const,reason:'unmeasurable source font'};
 },extGStateSetsFont:(name:string)=>environment.extGStates?.get(name)?.setsFont??null};
 const walk=walkTextPlacements(ops,{...callbacks,onXObject:(use,state)=>invocations.set(use.opIndex,state),onShow:s=>states.set(`${s.opIndex}:${s.arrayItemIndex}`,s),onTextOpEnd:(i,m)=>ends.set(i,m)});
 const glyphs:RetypesetGlyph[]=walk.ok?walk.glyphs.map(g=>({glyph:g,state:states.get(`${g.opIndex}:${g.arrayItemIndex}`)!,text:fonts.find(f=>f.resourceName===g.fontName)!.unicodeByCode.get(g.code),x:g.coreQuad[0].x,y:g.coreQuad[0].y})):[];
 return {fonts,walk,glyphs,callbacks,ends,invocations,verticalFonts};
}
/** Paragraph detection reuses the visual-group heuristic in a normalized
 * local text frame. It supplies approximate membership, never tier-1 proof. */
export function paragraphGroups(glyphs:RetypesetGlyph[],_ops:ContentOp[],target:RetypesetGlyph,selected:readonly RetypesetGlyph[]=[target]){
 const s=target.state,m=s.textMatrix!,c=s.ctm!;
 const a=m[0]!*c[0]!+m[1]!*c[2]!,b=m[0]!*c[1]!+m[1]!*c[3]!,cc=m[2]!*c[0]!+m[3]!*c[2]!,d=m[2]!*c[1]!+m[3]!*c[3]!,det=a*d-b*cc;
 if(!Number.isFinite(det)||Math.abs(det)<1e-10)throw Error('singular paragraph matrix');
 const local=(x:number,y:number)=>({x:(d*x-cc*y)/det,y:(a*y-b*x)/det});
 // Geometry owns membership. q/clip/MC belong to each original emission slot,
 // which the writer preserves; there is no independent clip counter to leak
 // past Q. Selected glyphs also survive size, baseline and frame changes.
 const owned=new Set(selected.map(g=>address(g.glyph))),bands:RetypesetGroup['lines']=[],lines:RetypesetGroup['lines']=[];
 for(const g of glyphs){
  const st=g.state,mm=st.textMatrix!,ct=st.ctm!;
  const sameFrame=[mm[0]!*ct[0]!+mm[1]!*ct[2]!,mm[0]!*ct[1]!+mm[1]!*ct[3]!,mm[2]!*ct[0]!+mm[3]!*ct[2]!,mm[2]!*ct[1]!+mm[3]!*ct[3]!].every((n,i)=>Math.abs(n-[a,b,cc,d][i]!)<1e-6);
  const isSelected=owned.has(address(g.glyph));
  if(!isSelected&&(!sameFrame||Math.abs(st.fontSize-s.fontSize)>.05||st.renderMode!==s.renderMode))continue;
  const p=local(g.x,g.y),right=p.x+retypesetAdvance(g,local),t={...g,...p};
  const band=bands.find(l=>Math.abs(l.y-p.y)<.05)??(isSelected?bands.filter(l=>Math.abs(l.y-p.y)<s.fontSize*.5).sort((a,b)=>Math.abs(a.y-p.y)-Math.abs(b.y-p.y))[0]:undefined);
  if(band){band.glyphs.push(t);band.x=Math.min(band.x,p.x);band.right=Math.max(band.right,right);}
  else bands.push({glyphs:[t],x:p.x,y:p.y,right});
 }
 for(const band of bands){
  let last:RetypesetGroup['lines'][number]|undefined;
  for(const g of band.glyphs.sort((a,b)=>a.x-b.x)){
   const right=g.x+retypesetAdvance(g,local),gap=last?g.x-last.right:Infinity;
   if(last&&gap>=-s.fontSize*.5&&gap<s.fontSize*2){last.glyphs.push(g);last.right=Math.max(last.right,right);}
   else{last={glyphs:[g],x:g.x,y:band.y,right};lines.push(last);}
  }
 }
 const trace=(g:RetypesetGlyph,x:number,y:number):TextTrace=>({bt:0,opIndex:g.glyph.opIndex,ctm:[1,0,0,1,0,0],tm:[1,0,0,1,x,y],tlm:[1,0,0,1,x,y],fontObject:g.glyph.fontName,size:s.fontSize,tc:0,tw:0,tz:100,leading:Math.abs(s.leading??0),rise:0,renderMode:0,safetyHash:'approximate',scopeSafe:true});
 const input:ParagraphLine[]=lines.map((l,i)=>({sourceGapBefore:i>0&&lines[i-1]!.y-l.y>s.fontSize*2.5&&Math.abs(lines[i-1]!.y-l.y-Math.abs(s.leading??0))>.5,anchor:trace(l.glyphs[0]!,l.x,l.y),ink:null,shows:l.glyphs.map(g=>({source:{streamHash:'approximate',opIndex:g.glyph.opIndex,itemIndex:g.glyph.arrayItemIndex,byteStart:g.glyph.byteOffset,byteEnd:g.glyph.byteOffset+g.glyph.byteLength,fontObject:g.glyph.fontName},unicode:g.text??'?',before:trace(g,g.x,l.y),after:trace(g,g.x+retypesetAdvance(g,local),l.y)}))}));
 const built=buildVisualGroups(input,input.find(l=>l.shows.some(sh=>sh.source.opIndex===target.glyph.opIndex))?.anchor??input[0]!.anchor,new Map());
 if(!built.ok)throw Error(built.detail);
 const groups:RetypesetGroup[]=built.groups.map(g=>({lines:lines.slice(g.start,g.end),left:Math.min(...lines.slice(g.start,g.end).map(l=>l.x)),right:g.capacityRight,pitch:g.pitchPt||s.fontSize*1.2}));
 const members=groups.filter(g=>g.lines.some(l=>l.glyphs.some(t=>owned.has(address(t.glyph))))),base=members[0];
 const group=base?{lines:members.flatMap(g=>g.lines),left:Math.min(...members.map(g=>g.left)),right:Math.max(...members.map(g=>g.right)),pitch:base.pitch}:undefined;
 return {group,local,global:(x:number,y:number)=>({x:a*x+cc*y,y:b*x+d*y})};
}
export function pageXObjects(page:PDFPage){
 const dict=page.node.Resources()?.lookupMaybe(PDFName.of('XObject'),PDFDict);
 return new Map((dict?.entries()??[]).map(([name,ref])=>{
  const raw=dict!.context.lookup(ref);return[name.decodeText(),raw instanceof PDFRawStream?raw.dict.lookupMaybe(PDFName.of('Subtype'),PDFName)?.decodeText():undefined];
 }));
}
