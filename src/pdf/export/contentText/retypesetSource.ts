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

export const address=(g:RetypesetGlyph['glyph'])=>`${g.opIndex}:${g.arrayItemIndex}:${g.byteOffset}`;
/** Extra placement-only fonts never grant exact-tier encoding permission. */
export function readRetypesetSource(page:PDFPage,ops:ContentOp[],options:Type1Options={}){
 const fonts=resolveRunFonts(page,options),extra=substituteSourceFonts(page);
 for(const f of extra)if(!fonts.some(a=>a.resourceName===f.resourceName))fonts.push(f);
 const states=new Map<string,ShowTextState>(),ends=new Map<number,{textMatrix:readonly number[];lineMatrix:readonly number[]}>(),environment=runPageEnvironment(page);
 const callbacks={includeStroked:true,resolveFont:(name:string)=>{
  const f=fonts.find(f=>f.resourceName===name);return f?{...f,ok:true as const,appliesWordSpacing:f.bytesPerCode===1}:{ok:false as const,reason:'unmeasurable source font'};
 },extGStateSetsFont:(name:string)=>environment.extGStates?.get(name)?.setsFont??null};
 const walk=walkTextPlacements(ops,{...callbacks,onShow:s=>states.set(`${s.opIndex}:${s.arrayItemIndex}`,s),onTextOpEnd:(i,m)=>ends.set(i,m)});
 const glyphs:RetypesetGlyph[]=walk.ok?walk.glyphs.map(g=>({glyph:g,state:states.get(`${g.opIndex}:${g.arrayItemIndex}`)!,text:fonts.find(f=>f.resourceName===g.fontName)!.unicodeByCode.get(g.code),x:g.coreQuad[0].x,y:g.coreQuad[0].y})):[];
 return {fonts,walk,glyphs,callbacks,ends};
}
/** Paragraph detection reuses the visual-group heuristic in a normalized
 * local text frame. It supplies approximate membership, never tier-1 proof. */
export function paragraphGroups(glyphs:RetypesetGlyph[],ops:ContentOp[],target:RetypesetGlyph){
 const s=target.state,m=s.textMatrix!,c=s.ctm!;
 const a=m[0]!*c[0]!+m[1]!*c[2]!,b=m[0]!*c[1]!+m[1]!*c[3]!,cc=m[2]!*c[0]!+m[3]!*c[2]!,d=m[2]!*c[1]!+m[3]!*c[3]!,det=a*d-b*cc;
 if(!Number.isFinite(det)||Math.abs(det)<1e-10)throw Error('singular paragraph matrix');
 const local=(x:number,y:number)=>({x:(d*x-cc*y)/det,y:(a*y-b*x)/det});
 // q/clip/marked-content identities are boundaries even for identical tags.
 const keys=new Map<number,string>(),q:number[]=[],marks:number[]=[];let clip=0;
 for(const [i,op]of ops.entries()){
  if(op.operator==='q')q.push(i);if(op.operator==='Q')q.pop();
  if(op.operator==='W'||op.operator==='W*')clip++;
  if(op.operator==='BMC'||op.operator==='BDC')marks.push(i);if(op.operator==='EMC')marks.pop();
  keys.set(i,JSON.stringify([q,marks,clip]));
 }
 const key=keys.get(target.glyph.opIndex),lines:RetypesetGroup['lines']=[];
 for(const g of glyphs){
  const st=g.state,mm=st.textMatrix!,ct=st.ctm!;
  const sameFrame=[mm[0]!*ct[0]!+mm[1]!*ct[2]!,mm[0]!*ct[1]!+mm[1]!*ct[3]!,mm[2]!*ct[0]!+mm[3]!*ct[2]!,mm[2]!*ct[1]!+mm[3]!*ct[3]!].every((n,i)=>Math.abs(n-[a,b,cc,d][i]!)<1e-6);
  if(keys.get(g.glyph.opIndex)!==key||!sameFrame||Math.abs(st.fontSize-s.fontSize)>.05||st.renderMode!==s.renderMode)continue;
  const p=local(g.x,g.y),right=local(g.glyph.coreQuad[1].x,g.glyph.coreQuad[1].y).x,t={...g,...p};
  const last=lines.at(-1);
  if(last&&Math.abs(last.y-p.y)<.05&&p.x>=last.right-.1&&p.x-last.right<s.fontSize*2){last.glyphs.push(t);last.right=Math.max(last.right,right);}
  else lines.push({glyphs:[t],x:p.x,y:p.y,right});
 }
 const trace=(g:RetypesetGlyph,x:number,y:number):TextTrace=>({bt:0,opIndex:g.glyph.opIndex,ctm:[1,0,0,1,0,0],tm:[1,0,0,1,x,y],tlm:[1,0,0,1,x,y],fontObject:g.glyph.fontName,size:s.fontSize,tc:0,tw:0,tz:100,leading:Math.abs(s.leading??0),rise:0,renderMode:0,safetyHash:key??'',scopeSafe:true});
 const input:ParagraphLine[]=lines.map((l,i)=>({sourceGapBefore:i>0&&lines[i-1]!.y-l.y>s.fontSize*2.5&&Math.abs(lines[i-1]!.y-l.y-Math.abs(s.leading??0))>.5,anchor:trace(l.glyphs[0]!,l.x,l.y),ink:null,shows:l.glyphs.map(g=>({source:{streamHash:'approximate',opIndex:g.glyph.opIndex,itemIndex:g.glyph.arrayItemIndex,byteStart:g.glyph.byteOffset,byteEnd:g.glyph.byteOffset+g.glyph.byteLength,fontObject:g.glyph.fontName},unicode:g.text??'?',before:trace(g,g.x,g.y),after:trace(g,local(g.glyph.coreQuad[1].x,g.glyph.coreQuad[1].y).x,g.y)}))}));
 const built=buildVisualGroups(input,input.find(l=>l.shows.some(sh=>sh.source.opIndex===target.glyph.opIndex))?.anchor??input[0]!.anchor,new Map());
 if(!built.ok)throw Error(built.detail);
 const groups:RetypesetGroup[]=built.groups.map(g=>({lines:lines.slice(g.start,g.end),left:Math.min(...lines.slice(g.start,g.end).map(l=>l.x)),right:g.capacityRight,pitch:g.pitchPt||s.fontSize*1.2}));
 return {group:groups.find(g=>g.lines.some(l=>l.glyphs.some(t=>address(t.glyph)===address(target.glyph))))!,local,global:(x:number,y:number)=>({x:a*x+cc*y,y:b*x+d*y})};
}
export function pageXObjects(page:PDFPage){
 const dict=page.node.Resources()?.lookupMaybe(PDFName.of('XObject'),PDFDict);
 return new Map((dict?.entries()??[]).map(([name,ref])=>{
  const raw=dict!.context.lookup(ref);return[name.decodeText(),raw instanceof PDFRawStream?raw.dict.lookupMaybe(PDFName.of('Subtype'),PDFName)?.decodeText():undefined];
 }));
}
