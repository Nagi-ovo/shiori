import type {ContentOp} from '../contentStreamEdit/tokenizer';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {removeIdentifiedGlyphs} from '../contentStreamEdit/removeGlyphs';
import {pdfName,pdfNumber,hex} from '../contentStreamEdit/runEncoding';
import type {readVerticalSource} from './verticalSource';
import type {VerticalAtom} from './verticalPlan';
import type {GlyphPlacement} from '../contentStreamEdit/textState';

/** q/Q preserves paint and font state; Tm plus a vertical TJ independently
 * restore both text matrices. A horizontal rejoin would shift later shows. */
export function emitVertical(bytes:Uint8Array,ops:ContentOp[],source:ReturnType<typeof readVerticalSource>,owned:GlyphPlacement[],atoms:VerticalAtom[]){
 const removed=removeIdentifiedGlyphs(bytes,ops,owned,undefined,pdfNumber);if(!removed.changed)throw Error('vertical-source: no addressed glyphs');
 const next=tokenizeContentStream(removed.bytes),showOps=(list:ContentOp[])=>list.filter(o=>['Tj','TJ',"'",'"'].includes(o.operator));
 const oldShows=showOps(ops),newShows=showOps(next);if(oldShows.length!==newShows.length)throw Error('vertical-source: changed show identity');
 const patches:{at:number;body:string}[]=[];
 // PDFium treats a numeric-only TJ as horizontal even in WMode 1. An
 // empty string selects its vertical path without painting an extra glyph.
 for(const [i,op]of newShows.entries()){
  const array=op.operands[0];
  if(op.operator==='TJ'&&array?.kind==='array'&&array.items.every(v=>v.kind==='number')&&owned.some(g=>ops[g.opIndex]===oldShows[i])){
   const segment=Array.from(removed.bytes.slice(op.start,op.end),b=>String.fromCharCode(b)).join('');
   patches.push({at:op.start+segment.indexOf('[')+1,body:'<> '});
  }
 }
 for(const opIndex of new Set(atoms.map(a=>a.home.glyph.opIndex))){
  const state=source.glyphs.find(g=>g.glyph.opIndex===opIndex)!.state,body=[' q '];
  for(const a of atoms.filter(a=>a.home.glyph.opIndex===opIndex)){
   const s=a.home.state,c=s.ctm!,m=s.textMatrix!,det=c[0]!*c[3]!-c[1]!*c[2]!;
   const x=(c[3]!*(a.pen.x-c[4]!)-c[2]!*(a.pen.y-c[5]!))/det-s.rise!*m[2]!;
   const y=(-c[1]!*(a.pen.x-c[4]!)+c[0]!*(a.pen.y-c[5]!))/det-s.rise!*m[3]!;
   body.push(`${[...m.slice(0,4),x,y].map(pdfNumber).join(' ')} Tm ${pdfName(a.font.resourceName)} ${pdfNumber(s.fontSize)} Tf ${hex(Uint8Array.of(a.code>>8,a.code&255))} Tj `);
  }
  const end=source.ends.get(opIndex)!,m=end.textMatrix,l=end.lineMatrix;
  const length=l[2]!**2+l[3]!**2,dy=((m[4]!-l[4]!)*l[2]!+(m[5]!-l[5]!)*l[3]!)/length;
  if(m.slice(0,4).some((v,i)=>v!==l[i])||Math.hypot(m[4]!-l[4]!-dy*l[2]!,m[5]!-l[5]!-dy*l[3]!)>1e-7)throw Error('vertical-source: text matrices cannot rejoin along the vertical advance');
  body.push(` Q ${l.map(pdfNumber).join(' ')} Tm [<> ${pdfNumber(-dy*1000/state.fontSize)}] TJ `);
  patches.push({at:newShows[oldShows.indexOf(ops[opIndex]!)]!.end,body:body.join('')});
 }
 let compiled=Array.from(removed.bytes,b=>String.fromCharCode(b)).join('');
 for(const p of patches.sort((a,b)=>b.at-a.at))compiled=compiled.slice(0,p.at)+p.body+compiled.slice(p.at);
 // Content tokens are byte-oriented. Preserve non-ASCII bytes outside shows.
 return Uint8Array.from(compiled,c=>c.charCodeAt(0));
}
