import { PDFHexString } from 'pdf-lib';
import { decodeTextBytes } from '../semantic/pdfValues';
import type {ContentOp} from '../contentStreamEdit/tokenizer';
import type {RetypesetGlyph} from './retypesetTypes';
import {address} from './retypesetSource';

type Span={bdc:number;extent:{start:number;end:number;valueStart:number};text:string;glyphs:RetypesetGlyph[]};
/** Inline `/ActualText` spans that enclose exactly one shown glyph. Their
 * replacement text is that glyph's label (what a reader extracts); a span
 * over several glyphs stays a semantic dependency and is not relabelled. */
export function singleGlyphActualText(ops:readonly ContentOp[],glyphs:readonly RetypesetGlyph[]){
 const stack:(Span|null)[]=[],spans:Span[]=[],byOp=new Map<number,RetypesetGlyph[]>();
 for(const g of glyphs){const list=byOp.get(g.glyph.opIndex)??[];list.push(g);byOp.set(g.glyph.opIndex,list);}
 for(const [i,op]of ops.entries()){
  if(op.operator==='BMC')stack.push(null);
  else if(op.operator==='BDC'){
   const props=op.operands[1],entry=props?.kind==='dict'?props.entries.find(e=>e.key==='ActualText'):undefined;
   const text=entry?.stringBytes && decodeTextBytes(entry.stringBytes);
   const span=entry&&text!==undefined?{bdc:i,extent:entry,text,glyphs:[]}:null;stack.push(span);if(span)spans.push(span);
  }else if(op.operator==='EMC')stack.pop();
  else for(const g of byOp.get(i)??[])for(const s of stack)s?.glyphs.push(g);
 }
 const labels=new Map<string,{text:string;span:Span}>();
 for(const s of spans)if(s.glyphs.length===1&&Array.from(s.text).length===1)labels.set(address(s.glyphs[0]!.glyph),{text:s.text,span:s});
 return labels;
}
/** Blanks the owned spans' ActualText entries byte for byte. Offsets and the
 * operator sequence are unchanged; the dictionaries keep their other keys. */
export function blankActualText(bytes:Uint8Array,extents:readonly {start:number;end:number}[]){
 const copy=bytes.slice();for(const e of extents)copy.fill(32,e.start,e.end);return copy;
}

export const columnTextValue = (text: string) => PDFHexString.fromText(text).toString().toLowerCase();
/** Wrap a show whose font label differs from the intended text. */
export const actualTextSpan = (text: string, show: string) => `/Span <</ActualText ${columnTextValue(text)}>> BDC ${show} EMC`;
