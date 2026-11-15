import {simpleNames,standardBuiltIn,standardFont} from './encodings';
import type {FontInput} from './types';
/** Exact unembedded Standard-14 only; never aliases or subset-name stripping. */
export function resolveStandardMetrics(input:FontInput) {
  if(input.subtype!=='Type1'||input.program!==undefined)return;
  const face=input.baseFont??'',font=standardFont(face);if(!font)return;
  const names=simpleNames(input,standardBuiltIn(face));
  return {face,names,verification:'assumed-standard' as const,widthOf:(code:number):number|undefined=>{
    const name=names.get(code);if(!name||name==='.notdef')return;
    const width=font.getWidthOfGlyph(name);return typeof width==='number'&&Number.isFinite(width)?width:undefined;
  }};
}
