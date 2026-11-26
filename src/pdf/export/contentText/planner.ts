import type { ContentTextOverlay } from '../../model/types';
import type { PageRunPlan } from '../contentStreamEdit/pageRunPlan';
import { sourceFingerprint, runContextSafety, type ResolvedRunFont, type RunUnsafeOperator } from '../contentStreamEdit/replaceRun';
import { removalsByRect } from '../contentStreamEdit/removeGlyphs';
import {ContentStreamParseError, tokenizeContentStream } from '../contentStreamEdit/tokenizer';
import { walkTextPlacements, type GlyphPlacement, type ShowTextState, type UnplacedShow } from '../contentStreamEdit/textState';
import { compilerReason, type ContentTextReason } from './outcomes';
import {RunCompileError} from '../contentStreamEdit/runRefusal';
import {textObjectScopes,followsUnplaced} from '../contentStreamEdit/textSafety';
import { lineChanges, multipleDeletions, singleDeletion } from './diff';
import { deletionRejoin, type MappedGlyph } from './deletionRejoin';
import {planReflow} from './reflowPlan';
import type {ContentTextEnvironment} from './reflowTypes';
export type ContentTextPlan = {ok:true;plan:PageRunPlan} | {ok:false;code:ContentTextReason;reason:string;unsafeOperator?:RunUnsafeOperator;terminal?:boolean};
const compact=(s:string)=>s.replace(/\s/gu,'');
const refuse=(code:ContentTextReason,reason:string=code,terminal=false):ContentTextPlan=>({ok:false,code,reason,...(terminal?{terminal}:{})});
function whitespaceEnd(text: string, start: number): number {
  while (start < text.length && /\s/u.test(text[start]!)) start++;
  return start;
}

function mapSelectionGlyphs(
  glyphs: readonly GlyphPlacement[], decoded: readonly string[], original: string, mapLiteralSpaces: boolean,
): MappedGlyph[] | null {
  const mapped: MappedGlyph[] = [];
  let cursor = 0;
  for (let i = 0; i < glyphs.length;) {
    const text = decoded[i]!;
    if (!compact(text)) {
      if (!mapLiteralSpaces) { i++; continue; }
      // Only an exact, complete source whitespace run can be addressed.
      // A space inferred from a positioning gap has no glyph to delete.
      const start = i;
      while (i < glyphs.length && !compact(decoded[i]!)) i++;
      const end = whitespaceEnd(original, cursor);
      const source = decoded.slice(start, i);
      if (source.join('') === original.slice(cursor, end)) {
        for (const [offset, space] of source.entries()) {
          mapped.push({ g: glyphs[start + offset]!, start: cursor, end: cursor + space.length });
          cursor += space.length;
        }
      }
      continue;
    }
    cursor = whitespaceEnd(original, cursor);
    const start = cursor;
    for (const ch of text) {
      if (!compact(ch)) continue;
      cursor = whitespaceEnd(original, cursor);
      if (!original.startsWith(ch, cursor)) return null;
      cursor += ch.length;
    }
    mapped.push({ g: glyphs[i]!, start, end: cursor });
    i++;
  }
  return mapped;
}
/** Pure mapping from the UI's source selection to byte-addressed compiler spans. */
export function planContentText(content:Uint8Array,fonts:readonly ResolvedRunFont[],overlay:ContentTextOverlay,environment:ContentTextEnvironment={}):ContentTextPlan {
  const originals=overlay.originalText.replace(/\r\n?/g,'\n').split('\n');
  const deleteAll=overlay.text===''&&!environment.reflowRequest;
  const replacements=deleteAll?originals.map(()=>''):overlay.text.replace(/\r\n?/g,'\n').split('\n');
  if(originals.length!==replacements.length&&!(environment.stage5Reflow&&environment.reflowRequest))return refuse('reflow-required');
  if(overlay.angle || overlay.align!=='left')return refuse('style-change');
  if(!overlay.sourceStyle)return refuse('missing-source-style');
  if(overlay.sourceStyle && (Object.keys(overlay.sourceStyle) as (keyof NonNullable<ContentTextOverlay['sourceStyle']>)[]).some(key=>overlay[key]!==overlay.sourceStyle![key]))return refuse('style-change');
  try {
    const byName=new Map(fonts.map(f=>[f.resourceName,f]));
    const ops=tokenizeContentStream(content),states=new Map<string,ShowTextState>();
    const unplaced:UnplacedShow[]=[];const scopes=textObjectScopes(ops);
    const walk=walkTextPlacements(ops,{resolveFont:name=>{
      const f=byName.get(name);return f?{...f,ok:true,appliesWordSpacing:f.bytesPerCode===1}:{ok:false,reason:'unsupported source font'};
    },extGStateSetsFont:name=>environment.extGStates?.get(name)?.setsFont??null,onUnplaced:s=>unplaced.push(s),onShow:s=>states.set(`${s.opIndex}:${s.arrayItemIndex}`,s)});
    if(!walk.ok)return refuse('unsupported-state',walk.reason);

    const selected=[...new Set(removalsByRect(walk.glyphs,overlay.coverRects).flatMap(s=>[...s]))];
    // Measured stroke glyphs are uneditable, but do not make later advances
    // unknown or poison unrelated text elsewhere in the same horizontal band.
    const addressedStrokes=unplaced.filter(s=>s.glyphs && removalsByRect([...s.glyphs],overlay.coverRects).some(hits=>hits.size));
    if(addressedStrokes.some(s=>Math.abs(s.fontSizePt-overlay.fontSize)>.05) || addressedStrokes.length && selected.some(g=>{
      const state=states.get(`${g.opIndex}:${g.arrayItemIndex}`);
      return !state || Math.abs((state.fontSizePt??state.fontSize)-overlay.fontSize)>.05;
    }))return refuse('style-change');
    if(addressedStrokes.length)return refuse('graphics-effect-unsupported','graphics-effect-unsupported: stroked text (Tr 1/2)');
    const unknown=unplaced.filter(s=>!s.advanceKnown);
    if(!selected.length)return refuse(unknown.length?'font-unavailable':walk.xobjects.length?'form-xobject':'source-mismatch');
    if(selected.some(g=>followsUnplaced(scopes,unknown.map(s=>s.opIndex),g.opIndex)))return refuse('font-unavailable','target follows an unknown advance in its text object');
    if(unknown.some(s=>s.origin && overlay.coverRects.some(r=>s.origin!.y>=r.y-Math.abs(s.fontSizePt) && s.origin!.y<=r.y+r.h+Math.abs(s.fontSizePt))))return refuse('font-unavailable','unplaced source text could intersect the selection');
    for(const g of selected) {
      const [a,b,,d]=g.coreQuad;
      if(Math.abs(a.y-b.y)>.01 || Math.abs(a.x-d.x)>.01 || b.x<a.x)return refuse('unsupported-matrix');
      const state=states.get(`${g.opIndex}:${g.arrayItemIndex}`);
      if(state?.renderMode===3)return refuse('graphics-effect-unsupported','invisible OCR text cannot replace visible page ink');
      if(!state || Math.abs((state.fontSizePt??state.fontSize)-overlay.fontSize)>.05)return refuse('style-change');
    }
    const lines:GlyphPlacement[][]=[];
    for(const g of selected.sort((a,b)=>b.coreQuad[0].y-a.coreQuad[0].y || a.coreQuad[0].x-b.coreQuad[0].x)) {
      let line=lines.find(l=>Math.abs(l[0]!.coreQuad[0].y-g.coreQuad[0].y)<=.01);
      if(!line){line=[];lines.push(line);}line.push(g);
    }
    if(environment.stage5Reflow&&environment.reflowRequest&&selected.every(g=>byName.get(g.fontName)?.unicodeByCode.has(g.code)))return planReflow(content,fonts,overlay,environment);
    if(lines.length!==originals.length)return refuse('reflow-required');
    const edits:PageRunPlan['edits'][number][]=[];
    for(let lineIndex=0;lineIndex<lines.length;lineIndex++) {
      const glyphs=lines[lineIndex]!,original=originals[lineIndex]!,replacement=replacements[lineIndex]!;
      const safety=runContextSafety(ops,environment);
      if(!safety.ok)return refuse(safety.code??'unsupported-state',safety.reason);
      const unsafe=glyphs.find(g=>safety.unsafe.has(g.opIndex));
      if(unsafe)return{ok:false,code:'unsupported-state',reason:'clip/graphics/semantic dependent target',unsafeOperator:safety.unsafeOperators.get(unsafe.opIndex)};
      for(const name of new Set(glyphs.map(g=>g.fontName))){
        const font=byName.get(name)!;
        font.assertSource?.(glyphs.filter(g=>g.fontName===name).map(g=>
          font.bytesPerCode===1?Uint8Array.of(g.code):Uint8Array.of(g.code>>8,g.code&255)));
      }
      const ordinaryEdit=!deleteAll&&!environment.reflowRequest;
      const single=ordinaryEdit?singleDeletion(original,replacement):undefined;
      const deletions=ordinaryEdit&&!single?multipleDeletions(original,replacement):undefined;
      const changes=deleteAll?[{start:0,end:original.length,replacement:''}]:single?[single]:deletions??lineChanges(original,replacement);
      const ordinaryDeletion=ordinaryEdit&&changes.length>0&&changes.every(change=>change.replacement==='');
      const multiDeletion=ordinaryDeletion&&changes.length>1;
      const decoded=glyphs.map(g=>byName.get(g.fontName)?.unicodeByCode.get(g.code));
      if(decoded.some(s=>s===undefined))return refuse('font-unavailable');
      for(let i=1;i<glyphs.length;i++) {
        if(Math.abs(glyphs[i]!.coreQuad[0].x-glyphs[i-1]!.coreQuad[0].x)<.01){
          if(!/^\s+$/u.test(decoded[i-1]!)||!/^\s+$/u.test(decoded[i]!))return refuse('ambiguous-match');
          if(!deleteAll&&!ordinaryDeletion){glyphs.splice(i,1);decoded.splice(i,1);i--;}
        }
      }
      const actual=decoded.join(''),needle=compact(original);
      if(!needle || compact(actual)!==needle) {
        const haystack=compact(actual),first=haystack.indexOf(needle);
        return refuse(needle && first>=0 && haystack.indexOf(needle,first+needle.length)>=0?'ambiguous-match':'source-mismatch');
      }
      const mapped=mapSelectionGlyphs(glyphs,decoded as string[],original,ordinaryDeletion);
      if(!mapped)return refuse('source-mismatch');
      for(const [index,rawChange] of changes.entries()) {
        let change=rawChange;
        if(change.start===change.end) {
          const before=mapped.find(m=>m.end===change.start),after=mapped.find(m=>m.start===change.start);
          const anchor=before??after;
          if(!anchor)return refuse('glyph-boundary');
          const text=original.slice(anchor.start,anchor.end);
          change={start:anchor.start,end:anchor.end,replacement:before?text+change.replacement:change.replacement+text};
        }
        const hits:MappedGlyph[]=deleteAll?glyphs.map(g=>({g,start:0,end:original.length})):
          mapped.filter(m=>m.end>change.start && m.start<change.end);
        // Insertions borrow no source bytes but must sit at a provable glyph
        // boundary; the compiler will conservatively refuse a zero-width slot.
        const first=hits[0],last=hits.at(-1);
        if(!first || !last || first.start!==change.start || last.end!==change.end)return refuse('glyph-boundary','glyph-boundary',multiDeletion);
        if(multiDeletion && hits.some((hit,i)=>i>0 && hits[i-1]!.end!==hit.start))return refuse('glyph-boundary','deletion spans unaddressed source text',true);
        const crossItem=hits.some(m=>m.g.opIndex!==first.g.opIndex || m.g.arrayItemIndex!==first.g.arrayItemIndex);
        const closeUpThrough=ordinaryDeletion?
          deletionRejoin(original,changes,index,mapped,walk.glyphs,ops,states.get(`${first.g.opIndex}:${first.g.arrayItemIndex}`)!):undefined;
        if(closeUpThrough===null)return refuse('unsupported-state','cannot prove a continuous source run for the deletion',true);
        if(crossItem && !deleteAll && !closeUpThrough && (hits.length!==Array.from(change.replacement).length || Array.from(original.slice(change.start,change.end)).length!==Array.from(change.replacement).length || hits.some(m=>Array.from(original.slice(m.start,m.end)).length!==1)))return refuse('cross-item');
        const groups:MappedGlyph[][]=[];
        for(const hit of hits){
          const previous=groups.at(-1), tail=previous?.at(-1)?.g;
          if(tail?.opIndex===hit.g.opIndex && tail.arrayItemIndex===hit.g.arrayItemIndex &&
             (!deleteAll || tail.byteOffset+tail.byteLength===hit.g.byteOffset))previous!.push(hit);
          else groups.push([hit]);
        }
        let replacementOffset=0;
        for(const [groupIndex,group] of groups.entries()){
        const first=group[0]!,last=group.at(-1)!;
        const part=crossItem?Array.from(change.replacement).slice(replacementOffset,replacementOffset+group.length).join(''):change.replacement;
        replacementOffset+=group.length;
        const g=first.g,font=byName.get(g.fontName)!;
        const op=ops[g.opIndex]!;
        if(!['Tj','TJ'].includes(op.operator))return refuse('unsupported-state');
        const item=op.operator==='TJ' && op.operands[0]?.kind==='array'?op.operands[0].items[g.arrayItemIndex]:op.operands[0];
        if(item?.kind!=='string')return refuse('cross-item');
        const start=g.byteOffset,end=last.g.byteOffset+last.g.byteLength;
        const rejoin=closeUpThrough&&{...closeUpThrough,gapPt:groupIndex===0?closeUpThrough.gapPt:0};
        edits.push({fontResource:g.fontName,fontObject:font.objectId,opIndex:g.opIndex,itemIndex:g.arrayItemIndex,
          byteStart:start,byteEnd:end,expected:item.bytes.slice(start,end),replacement:part,...(rejoin?{closeUpThrough:rejoin}:{})});
        }
      }
    }
    return {ok:true,plan:{sourceHash:sourceFingerprint(content),edits,allowExistingCodePermutation:true,...environment}};
  }catch(error){if(error instanceof RunCompileError)return refuse(compilerReason({ok:false,code:error.code,reason:error.message}),error.message);if(error instanceof ContentStreamParseError)return refuse('unsupported-state',error.message);throw error;}
}
