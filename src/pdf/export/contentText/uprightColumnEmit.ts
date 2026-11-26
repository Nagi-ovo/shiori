import {PDFDict,PDFName,type PDFPage} from 'pdf-lib';
import {hasStructure} from '../semantic/probe';
import type {ResolvedRunFont} from '../contentStreamEdit/replaceRun';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {removeIdentifiedGlyphs} from '../contentStreamEdit/removeGlyphs';
import {hex,pdfName,pdfNumber} from '../contentStreamEdit/runEncoding';
import {restoreReflowSlot} from './reflowEmit';
import {address,type readRetypesetSource} from './retypesetSource';
import type {RetypesetGlyph} from './retypesetTypes';
import {actualTextSpan,blankActualText,columnTextValue,type singleGlyphActualText} from './uprightColumnActualText';

export type ColumnAtom={text:string;font:ResolvedRunFont;bytes:Uint8Array;code:number;home:RetypesetGlyph;anchor?:RetypesetGlyph;origin:{x:number;y:number};box:import('../../model/types').PdfRect};
/** Each output glyph emits after its home show inside q/Q with its own Tm;
 * the home slot's end-of-show text matrices are then restored for later shows. */
export function emitColumn(page:PDFPage,bytes:Uint8Array,ops:ReturnType<typeof tokenizeContentStream>,source:ReturnType<typeof readRetypesetSource>,owned:RetypesetGlyph[],atoms:ColumnAtom[],fonts:ResolvedRunFont[],labels:ReturnType<typeof singleGlyphActualText>){
 const equivalents=new Map(owned.flatMap(g=>{const key=address(g.glyph),label=labels.get(key);return label?[[key,label]as const]:[];}));
 // An overflow may place several new cells at one former show. A single
 // ActualText value across them changes their native extraction bounds.
 // Keep the R1 per-show encoding in that case, including its disposition.
 const byHome=new Map<string,ColumnAtom[]>();
 for(const atom of atoms){
  const key=address((atom.anchor??atom.home).glyph),group=byHome.get(key)??[];
  group.push(atom);byHome.set(key,group);
 }
 const fontDict=page.node.Resources()?.lookupMaybe(PDFName.of('Font'),PDFDict);
 const stripped=[];
 if(!hasStructure(page.doc))for(const [key,label]of equivalents){
  const group=byHome.get(key)??[],atom=group[0];
  // PDFium gives a Type3 character a different extraction extent even
  // when its ActualText repeats the code's exact Unicode value.
  const redundantType3=atom&&atom.text!==label.text&&atom.font.unicodeByCode.get(atom.code)===atom.text&&
   fontDict?.lookupMaybe(PDFName.of(atom.font.resourceName),PDFDict)?.get(PDFName.of('Subtype'))===PDFName.of('Type3');
  if(group.length>1||redundantType3){stripped.push(label.span.extent);equivalents.delete(key);}
 }
 const keep=new Set([...equivalents.values()].map(l=>l.span.bdc));
 const input=blankActualText(bytes,stripped);
 const inputOps=stripped.length?tokenizeContentStream(input):ops;
 const removed=removeIdentifiedGlyphs(input,inputOps,owned.map(g=>g.glyph),undefined,pdfNumber,keep);if(!removed.changed)throw Error('vertical-source: no addressed glyphs');
 const next=tokenizeContentStream(removed.bytes),shows=(list:typeof ops)=>list.flatMap((o,i)=>['Tj','TJ',"'",'"'].includes(o.operator)?[i]:[]);
 const oldShows=shows(ops),newShows=shows(next);if(oldShows.length!==newShows.length)throw Error('vertical-source: changed show identity');
 const patches:{at:number;end?:number;body:string}[]=[];
 // Quote shows expand during removal. BDC order stays the same.
 const marks=(list:typeof ops)=>list.filter(op=>op.operator==='BDC');
 const originalMarks=marks(ops),nextMarks=marks(next);
 for(const [key,label]of equivalents){
  const text=atoms.filter(a=>address((a.anchor??a.home).glyph)===key).map(a=>a.text).join('');
  if(text===label.text)continue;
  const op=nextMarks[originalMarks.indexOf(ops[label.span.bdc]!)]!,props=op.operands[1];
  const entry=props?.kind==='dict'&&props.entries.find(e=>e.key==='ActualText');
  if(!entry)throw Error('vertical-source: lost a cell property');
  patches.push({at:entry.valueStart,end:entry.end,body:columnTextValue(text)});
 }
 for(const opIndex of new Set(atoms.map(a=>(a.anchor??a.home).glyph.opIndex))){
  const body=[' q'];
  for(const a of atoms.filter(a=>(a.anchor??a.home).glyph.opIndex===opIndex)){
   const s=a.home.state,c=(a.anchor??a.home).state.ctm!,m=s.textMatrix!,det=c[0]!*c[3]!-c[1]!*c[2]!;
   const x=(c[3]!*(a.origin.x-c[4]!)-c[2]!*(a.origin.y-c[5]!))/det-s.rise!*m[2]!;
   const y=(-c[1]!*(a.origin.x-c[4]!)+c[0]!*(a.origin.y-c[5]!))/det-s.rise!*m[3]!;
   const show=`${[...m.slice(0,4),x,y].map(pdfNumber).join(' ')} Tm ${pdfName(a.font.resourceName)} ${pdfNumber(s.fontSize)} Tf ${hex(a.bytes)} Tj`;
   // A reused code whose ToUnicode differs from the intended scalar (a
   // compatibility or presentation form) carries its own ActualText.
   body.push(equivalents.has(address((a.anchor??a.home).glyph))||a.font.unicodeByCode.get(a.code)===a.text?show:actualTextSpan(a.text,show));
  }
  const s={...source.glyphs.find(g=>g.glyph.opIndex===opIndex)!.state,...source.ends.get(opIndex)!};
  body.push('Q',restoreReflowSlot({bt:0,opIndex,ctm:s.ctm!,tm:s.textMatrix!,tlm:s.lineMatrix!,fontObject:fonts.find(f=>f.resourceName===s.fontName)!.objectId,size:s.fontSize,tc:s.charSpacing,tw:s.wordSpacing,tz:s.horizontalScale!*100,leading:s.leading!,rise:s.rise!,renderMode:s.renderMode!,safetyHash:'approximate'},fonts));
  patches.push({at:next[newShows[oldShows.indexOf(opIndex)]!]!.end,body:body.join(' ')+' '});
 }
 let compiled=Array.from(removed.bytes,b=>String.fromCharCode(b)).join('');
 for(const p of patches.sort((a,b)=>b.at-a.at))compiled=compiled.slice(0,p.at)+p.body+compiled.slice(p.end??p.at);
 return {compiled:Uint8Array.from(compiled,ch=>ch.charCodeAt(0)),equivalents:new Set(equivalents.keys()),strippedEquivalent:stripped.length>0};
}
