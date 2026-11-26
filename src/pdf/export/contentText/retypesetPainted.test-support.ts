import {PDFName} from 'pdf-lib';
import {fixture,overlay} from './fixtures.test-support';
import {applyRetypesets} from './retypeset';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {readRetypesetSource} from './retypesetSource';
import {chainScenarios,title} from './retypesetChain.scenarios.test-support';
import {retypesetPaintedShadow,type RetypesetPaintedObservation} from './retypesetPainted';
import type {ContentTextOutcome} from './outcomes';

/** A note turned 90 degrees in the right margin (x 284..292, y 30..75):
 * Courier, so it has a published Standard 14 envelope but no horizontal
 * ink measure. Today it reads as a whole-page box. */
export const sideNote='BT /F1 8 Tf 0 1 -1 0 292 30 Tm (SIDE NOTE) Tj ET ';
/** The same note in a font with no outline, no declared box and no
 * Standard 14 name: it has no envelope and must stay unknown. */
export const bareSideNote='BT /F2 8 Tf 0 1 -1 0 292 30 Tm (SIDE NOTE) Tj ET ';
const rule='0.4 w 10 127 m 290 127 l S ',body='BT /F1 10 Tf 50 105 Td (FOLLOWING) Tj ET ';
export const lone='BT /F1 10 Tf 50 138 Td (EEEE FFFF GGGG HHHH) Tj ET '+rule+'BT /F1 10 Tf 50 105 Td (ZZZZ ZZ) Tj ET ';
const para='BT /F1 10 Tf 12 TL 50 150 Td (AAAA BBBB CCCC DDDD) Tj T* (EEEE FFFF GGGG HHHH) Tj ET ';
type Edit=[string,string,number,number[]];
const grow=(suffix:string):Edit=>['EEEE FFFF GGGG HHHH','EEEE FFFF GGGG HHHH'+suffix,10,[49,136,116,11]];
export const titleBy=(text:string):Edit=>['ABCDEFGHIJ',text,20,[49,147,122,24]];
type Strategy=RetypesetPaintedObservation['strategy'];
/** In-tree analogues of every successful corpus strategy (push, chain push,
 * frame tighten, witnessed and own-band envelope), plus clear and failure
 * rows. `strategy` is today's outcome. */
export const identityScenarios:Record<string,{stream:string;edit?:Edit;strategy:Strategy;image?:boolean;rotated?:true}>={
 'push-rule':{stream:title+'0.4 w 47 127 m 173 127 l S '+body+'BT /F1 10 Tf 220 105 Td (OTHER) Tj ET',strategy:'push'},
 'push-image':{stream:title+'q 126 0 0 18 47 114 cm /Image Do Q '+body+'BT /F1 10 Tf 220 105 Td (OTHER) Tj ET',strategy:'push',image:true},
 'chain-wide-row':{stream:chainScenarios['wide-row']!.stream,strategy:'chain-push'},
 'chain-hidden':{stream:chainScenarios['wide-row-hidden']!.stream,strategy:'chain-push'},
 'chain-rotated-margin':{stream:chainScenarios['rotated-margin']!.stream,strategy:'chain-push',rotated:true},
 // A turned note inside the column: the chain moves it with the column.
 'chain-rotated-column':{stream:title+'BT /F1 8 Tf 0 1 -1 0 62 110 Tm (NOTE) Tj ET ',edit:titleBy('ABCDEFGHIJKLM'),strategy:'chain-push',rotated:true},
 'frame-cell':{stream:'0.4 w 45 140 m 175 140 l S 45 174 m 175 174 l S 45 140 m 45 174 l S 175 140 m 175 174 l S '+title+body,strategy:'tighten-frame'},
 'frame-box':{stream:'0.4 w 45 140 130 34 re S '+title+body,strategy:'tighten-frame'},
 'envelope-witnessed':{stream:para+rule+body,edit:grow('I'),strategy:'fit-envelope'},
 'envelope-own-band':{stream:lone,edit:grow('I'),strategy:'fit-envelope'},
 'clear-wrap':{stream:title,strategy:'none'},
 'refused-foreign':{stream:chainScenarios['wide-row-foreign']!.stream,edit:chainScenarios['wide-row-foreign']!.edit,strategy:'none'},
};
export async function runPainted(stream:string,edit:Edit=titleBy('ABCDEFGHIJK'),opts:{image?:boolean;observe?:boolean}={}){
 const f=await fixture(stream);
 // F2: a simple font with widths and Unicode but no envelope of any kind.
 const fonts=f.page.node.Resources()!.lookup(PDFName.of('Font')) as import('pdf-lib').PDFDict;
 fonts.set(PDFName.of('F2'),f.doc.context.register(f.doc.context.obj({Type:'Font',Subtype:'Type1',BaseFont:'ShioriNoEnvelope',FirstChar:32,Widths:Array(95).fill(600),Encoding:'WinAnsiEncoding'})));
 if(opts.image){const ref=f.doc.context.register(f.doc.context.stream(Uint8Array.of(0),{Type:'XObject',Subtype:'Image',Width:1,Height:1,ColorSpace:'DeviceGray',BitsPerComponent:8}));f.page.node.Resources()!.set(PDFName.of('XObject'),f.doc.context.obj({Image:ref}));}
 const [originalText,text,fontSize,[x,y,w,h]]=edit;
 const e=overlay({text,originalText,fontSize,coverRects:[{x:x!,y:y!,w:w!,h:h!}]});
 const seen:RetypesetPaintedObservation[]=[],previous=retypesetPaintedShadow.observe;
 retypesetPaintedShadow.observe=opts.observe===false?undefined:o=>seen.push(o);
 const outcomes=new Map<string,ContentTextOutcome>();
 try{await applyRetypesets(f.page,[e],outcomes,new Set(),{});}finally{retypesetPaintedShadow.observe=previous;}
 const s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);
 const glyphs=readRetypesetSource(f.page,tokenizeContentStream(s.bytes)).glyphs;
 return{m:outcomes.get(e.id)!.retypeset!,seen,glyphs,bytes:s.bytes};
}
/** Same edit with no observer at all: the shadow must not be what changes
 * the output. */
export const runUnobserved=(stream:string,edit?:Edit,opts:{image?:boolean}={})=>runPainted(stream,edit,{...opts,observe:false});
