import {PDFName} from 'pdf-lib';
import {fixture,overlay} from './fixtures.test-support';
import {applyRetypesets} from './retypeset';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {readRetypesetSource} from './retypesetSource';
import type {ContentTextOutcome} from './outcomes';

// A 20 pt title in a 50..170 column; adding one letter wraps it by 24 pt.
export const title='BT /F1 20 Tf 24 TL 50 150 Td (ABCDEFGHIJ) Tj ET ';
const wide='BT /F1 10 Tf 20 120 Td (FULL MEASURE ROW BELOW THE TITLE) Tj ET ',body='BT /F1 10 Tf 50 100 Td (FOLLOWING) Tj ET ';
/** Rows the pipeline before the chain leaves overlapping. Refused scenarios
 * grow the title by three letters: one letter fits its own ink band since
 * r31 P2-A, three need .83 of the size, below the .85 floor. */
const beyondOwnBand:[string,string,number,number[]]=['ABCDEFGHIJ','ABCDEFGHIJKLM',20,[49,147,122,24]];
export const chainScenarios:Record<string,{stream:string;annots?:number[][];edit?:[string,string,number,number[]]}>={
 // A full-measure row with nothing foreign beside it, then column text.
 'wide-row':{stream:title+wide+body},
 // The same chain, but its last follower would sweep over a link
 // annotation: no member may move.
 'wide-row-blocked':{stream:title+wide+body,annots:[[40,62,120,76]],edit:beyondOwnBand},
 // The wider row shares x with a foreign column beside the title.
 'wide-row-foreign':{stream:title+'BT /F1 10 Tf 20 120 Td (WIDE ROW REACHING THE NEXT COL) Tj ET '+body+'BT /F1 10 Tf 12 TL 182 130 Td (OTHER) Tj T* (SIDE) Tj ET',edit:beyondOwnBand},
 // A running head wraps into the rule under it. The rule spans the measure
 // but lies in the top tenth of the page, so it is furniture.
 'running-head':{stream:'BT /F1 10 Tf 12 TL 60 190 Td (RUNNING HEAD) Tj ET 0.4 w 30 184 m 270 184 l S BT /F1 10 Tf 60 150 Td (BODY TEXT) Tj ET',edit:['RUNNING HEAD','RUNNING HEAD XYZ',10,[59,187,74,12]]},
 // Invisible text below the column paints nothing; the accepted chain
 // leaves it where it is.
 'wide-row-hidden':{stream:title+wide+body+'BT 3 Tr /F1 10 Tf 60 85 Td (HIDDEN) Tj ET'},
 // A chain of rows 20 pt apart whose last row would land in the page foot.
 'page-foot':{stream:title+wide+'BT /F1 10 Tf 20 TL 50 100 Td (FOLLOWING) Tj T* (ROW TWO) Tj T* (ROW THREE) Tj T* (ROW FOUR) Tj ET',edit:beyondOwnBand},
 // The existing rule push, plus a note turned 90 degrees in the right
 // margin whose glyphs have no horizontal ink measure.
 'rotated-margin':{stream:title+'0.4 w 47 127 m 173 127 l S BT /F1 10 Tf 50 105 Td (FOLLOWING) Tj ET '+'BT /F1 8 Tf 0 1 -1 0 292 30 Tm (SIDE NOTE) Tj ET'},
};
export async function runChainScenario(name:string){
 const c=chainScenarios[name]!,f=await fixture(c.stream);
 if(c.annots)f.page.node.set(PDFName.of('Annots'),f.doc.context.obj(c.annots.map(Rect=>({Type:'Annot',Subtype:'Link',Rect}))));
 const before=readRetypesetSource(f.page,tokenizeContentStream((inspectRunPage(f.page) as {bytes:Uint8Array}).bytes)).glyphs;
 const [originalText,text,fontSize,[x,y,w,h]]=c.edit??['ABCDEFGHIJ','ABCDEFGHIJK',20,[49,147,122,24]];
 const e=overlay({text,originalText,fontSize,coverRects:[{x:x!,y:y!,w:w!,h:h!}]});
 const outcomes=new Map<string,ContentTextOutcome>();await applyRetypesets(f.page,[e],outcomes,new Set(),{});
 const s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);
 const after=readRetypesetSource(f.page,tokenizeContentStream(s.bytes)).glyphs;
 return{f,m:outcomes.get(e.id)!.retypeset!,before,after,bytes:s.bytes};
}
