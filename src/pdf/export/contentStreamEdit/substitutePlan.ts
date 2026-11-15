import type {ContentTextOverlay} from '../../model/types';
import {runContextSafety,type RunEdit} from './replaceRun';
import {removalsByRect,quadIntersectsRect} from './removeGlyphs';
import {tokenizeContentStream} from './tokenizer';
import {walkTextPlacements,type GlyphPlacement,type ShowTextState,type UnplacedShow} from './textState';
import {textObjectScopes,followsUnplaced,type RunEnvironment} from './textSafety';
import {RunCompileError} from './runRefusal';
import {substituteFontName} from './substituteFonts';
import type {SubstituteSourceFont} from './substituteSource';

export type SubstituteLine={text:string;fontName:string;state:ShowTextState;origin:{x:number;y:number};availablePt:number;glyphs:GlyphPlacement[]};
const compact=(s:string)=>s.replace(/\s/gu,'');
function fail(message:string,code:ConstructorParameters<typeof RunCompileError>[1]='font-unavailable'):never{throw new RunCompileError(message,code);}
/** Own the entire selected line; later show items are blanked with their
 * original advances retained. No wrapping, spacing tactic or reflow recipe. */
export function planSubstitution(content:Uint8Array,fonts:SubstituteSourceFont[],overlay:ContentTextOverlay,environment:RunEnvironment){
 if(!overlay.sourceStyle||overlay.angle||overlay.align!=='left'||Object.entries(overlay.sourceStyle).some(([k,v])=>overlay[k as keyof ContentTextOverlay]!==v))fail('substitution requires unchanged source style','unsupported-state');
 const ops=tokenizeContentStream(content),states=new Map<string,ShowTextState>(),unplaced:UnplacedShow[]=[];
 const walk=walkTextPlacements(ops,{resolveFont:name=>{const font=fonts.find(f=>f.resourceName===name);return font?{...font,ok:true,appliesWordSpacing:font.bytesPerCode===1}:{ok:false,reason:'unmeasurable source font'};},
  extGStateSetsFont:name=>environment.extGStates?.get(name)?.setsFont??null,onShow:s=>states.set(`${s.opIndex}:${s.arrayItemIndex}`,s),onUnplaced:s=>unplaced.push(s)});
 if(!walk.ok)fail(walk.reason,'unsupported-state');
 const hits=new Set(removalsByRect(walk.glyphs,overlay.coverRects).flatMap(set=>[...set]));
 if(!hits.size)fail('no addressable source glyphs');
 if(unplaced.some(s=>s.glyphs?.some(g=>overlay.coverRects.some(r=>quadIntersectsRect(g.quad,r)))))fail('addressed stroked text','graphics-effect-unsupported');
 const unknown=unplaced.filter(s=>!s.advanceKnown),scopes=textObjectScopes(ops);
 if([...hits].some(g=>followsUnplaced(scopes,unknown.map(s=>s.opIndex),g.opIndex))||unknown.some(s=>!s.origin||overlay.coverRects.some(r=>s.origin!.y>=r.y-Math.abs(s.fontSizePt)&&s.origin!.y<=r.y+r.h+Math.abs(s.fontSizePt))))fail('unknown source advance could intersect substitution');
 if(walk.glyphs.some(g=>!hits.has(g)&&overlay.coverRects.some(r=>quadIntersectsRect(g.quad,{x:r.x+.02,y:r.y+.02,w:Math.max(0,r.w-.04),h:Math.max(0,r.h-.04)}))))fail('selection intersects unowned text');
 // A source glyph can paint just beyond its advance box at raster edges.
 // Refuse tightly cropped covers instead of changing pixels outside them.
 if([...hits].some(g=>!overlay.coverRects.some(r=>g.quad.every(p=>p.x>=r.x+.5&&p.x<=r.x+r.w-.5&&p.y>=r.y+.5&&p.y<=r.y+r.h-.5))))fail('source glyph extent exceeds safe cover','overflow');
 const safety=runContextSafety(ops,environment);if(!safety.ok)fail(safety.reason,safety.code);
 const lines:GlyphPlacement[][]=[];
 for(const g of [...hits].sort((a,b)=>b.coreQuad[0].y-a.coreQuad[0].y||a.coreQuad[0].x-b.coreQuad[0].x)){
  if(![...g.quad,...g.coreQuad].every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y))||Math.abs(g.coreQuad[0].y-g.coreQuad[1].y)>.01||Math.abs(g.coreQuad[0].x-g.coreQuad[3].x)>.01||g.coreQuad[1].x<=g.coreQuad[0].x)fail('unsupported substitution matrix','unsupported-matrix');
  if(safety.unsafe.has(g.opIndex))fail('clip/graphics/semantic dependent source','unsupported-state');
  const line=lines.find(l=>Math.abs(l[0]!.coreQuad[0].y-g.coreQuad[0].y)<=.01);if(line)line.push(g);else lines.push([g]);
 }
 const originals=overlay.originalText.replace(/\r\n/g,'\n').split('\n'),replacements=overlay.text.replace(/\r\n/g,'\n').split('\n');
 if(lines.length!==originals.length||lines.length!==replacements.length)fail('substitution requires unchanged line breaks','overflow');
 const edits:RunEdit[]=[],planned:SubstituteLine[]=[];
 lines.forEach((glyphs,index)=>{
  const first=glyphs[0]!,last=glyphs.at(-1)!,font=fonts.find(f=>f.resourceName===first.fontName)!,state=states.get(`${first.opIndex}:${first.arrayItemIndex}`)!;
  if(!state||Math.abs((state.fontSizePt??state.fontSize)-overlay.fontSize)>.05||state.fontSize<=0||state.advanceVector.x<=0||Math.abs(state.advanceVector.y)>.01)fail('unsupported source size or matrix','unsupported-matrix');
  if(font.sourceBox){
   const box=font.sourceBox,xScale=state.fontSize*state.advanceVector.x/1000,yScale=(state.fontSizePt??state.fontSize)/1000;
   if(glyphs.some(g=>!overlay.coverRects.some(r=>g.coreQuad[0].x+box[0]!*xScale>=r.x+.5&&g.coreQuad[0].x+box[2]!*xScale<=r.x+r.w-.5&&g.coreQuad[0].y+box[1]!*yScale>=r.y+.5&&g.coreQuad[0].y+box[3]!*yScale<=r.y+r.h-.5)))fail('Type3 font bounds exceed safe cover','overflow');
  }
  if(glyphs.some(g=>g.fontName!==first.fontName||Math.abs((states.get(`${g.opIndex}:${g.arrayItemIndex}`)?.fontSizePt??0)-overlay.fontSize)>.05))fail('mixed source styles','unsupported-state');
  const decoded=glyphs.map(g=>font.unicodeByCode.get(g.code));
  if(decoded.some(t=>t===undefined)||!compact(originals[index]!)||compact(decoded.join(''))!==compact(originals[index]!))fail('source text cannot be proven');
  if(glyphs.some((g,i)=>i>0&&g.coreQuad[0].x<glyphs[i-1]!.coreQuad[1].x-.01))fail('overlapping source glyphs');
  const origin=first.coreQuad[0];
  const lastState=states.get(`${last.opIndex}:${last.arrayItemIndex}`)!;
  let availablePt=last.coreQuad[0].x+last.tjCompensation*lastState.fontSize*lastState.advanceVector.x/1000-origin.x;
  for(const g of walk.glyphs)if(!hits.has(g)&&Math.abs(g.coreQuad[0].y-origin.y)<=.01&&g.coreQuad[0].x>=origin.x)availablePt=Math.min(availablePt,g.coreQuad[0].x-origin.x);
  const groups:GlyphPlacement[][]=[];
  for(const g of glyphs){const prev=groups.at(-1),tail=prev?.at(-1);if(tail&&tail.opIndex===g.opIndex&&tail.arrayItemIndex===g.arrayItemIndex&&tail.byteOffset+tail.byteLength===g.byteOffset)prev!.push(g);else groups.push([g]);}
  groups.forEach((group,n)=>{
   const first=group[0]!,last=group.at(-1)!,op=ops[first.opIndex]!;
   if(!['Tj','TJ'].includes(op.operator))fail('unsupported source show','unsupported-state');
   const item=op.operator==='TJ'&&op.operands[0]?.kind==='array'?op.operands[0].items[first.arrayItemIndex]:op.operands[0];
   if(item?.kind!=='string')fail('source show changed','stale-source');
   edits.push({fontResource:font.resourceName,fontObject:font.objectId,opIndex:first.opIndex,itemIndex:first.arrayItemIndex,byteStart:first.byteOffset,byteEnd:last.byteOffset+last.byteLength,
    expected:item.bytes.slice(first.byteOffset,last.byteOffset+last.byteLength),replacement:n===0?replacements[index]!:''});
  });
  planned.push({text:replacements[index]!,fontName:substituteFontName(font.base,font.flags,replacements[index]!),state,origin,availablePt,glyphs});
 });
 return {edits,lines:planned};
}
