import assert from 'node:assert/strict';
import {PDFDict,PDFDocument,PDFName,PDFObjectCopier,PDFRef,type PDFPage} from 'pdf-lib';
import {inspectRunPage} from '../../src/pdf/export/contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../../src/pdf/export/contentStreamEdit/tokenizer';
import {readRetypesetSource} from '../../src/pdf/export/contentText/retypesetSource';
import {notdefProbePdf} from '../pdf-inplace/notdefProbe';
import type {Type1Options} from '../../src/pdf/export/fontCoverage/type1Support';

/** Retypeset may reuse an unembedded Standard-14 font. Locate the actual saved
 * resource by native Unicode/origin, then verify the probe's native program
 * hash in auditCorpusSample, just as for embedded replacement fonts. */
export function retypesetFontObjects(page:PDFPage,glyphs:readonly {text:string;origin:readonly number[];fontHash?:string}[],options:Type1Options){
 const stream=inspectRunPage(page);assert(stream.ok,'retypeset stream unreadable');
 const source=readRetypesetSource(page,tokenizeContentStream(stream.bytes),options);assert(source.walk.ok,'retypeset font walk failed');
 const fonts=page.node.Resources()?.lookupMaybe(PDFName.of('Font'),PDFDict),objects=new Map<string,string>();
 for(const g of glyphs){
  if(!g.fontHash||!g.text.trim())continue;
  const at=source.glyphs.find(s=>s.text===g.text&&Math.hypot(s.x-g.origin[0]!,s.y-g.origin[1]!)<=.01);
  const ref=at?fonts?.get(PDFName.of(at.glyph.fontName)):undefined;
  if(ref instanceof PDFRef)objects.set(g.fontHash,ref.toString());
 }
 return objects;
}

export async function retypesetNotdefProbePdf(bytes:Uint8Array,object:string){
 const original=await PDFDocument.load(bytes),[id,generation]=object.split(' ').map(Number),font=original.context.lookup(PDFRef.of(id!,generation!),PDFDict);
 const descriptor=font.lookupMaybe(PDFName.of('FontDescriptor'),PDFDict);
 if(font.get(PDFName.of('Subtype'))===PDFName.of('Type0')||['FontFile','FontFile2','FontFile3'].some(k=>descriptor?.has(PDFName.of(k))))return notdefProbePdf(bytes,[object]);
 assert.equal(font.get(PDFName.of('Subtype')),PDFName.of('Type1'),'unembedded retypeset probe requires Type1');
 const doc=await PDFDocument.create(),copied=PDFObjectCopier.for(original.context,doc.context).copy(font);
 copied.set(PDFName.of('Encoding'),doc.context.obj({Differences:[0,'.notdef','.notdef']}));
 copied.set(PDFName.of('ToUnicode'),doc.context.register(doc.context.flateStream('2 beginbfchar <00> <fffe> <01> <ffff> endbfchar')));
 copied.set(PDFName.of('FirstChar'),doc.context.obj(0));copied.set(PDFName.of('LastChar'),doc.context.obj(1));copied.set(PDFName.of('Widths'),doc.context.obj([500,500]));
 const page=doc.addPage([100,100]);page.node.set(PDFName.of('Resources'),doc.context.obj({Font:{Probe:doc.context.register(copied)}}));
 page.node.set(PDFName.of('Contents'),doc.context.register(doc.context.flateStream('BT /Probe 12 Tf 10 50 Td <0001> Tj ET')));
 return doc.save({useObjectStreams:false});
}
