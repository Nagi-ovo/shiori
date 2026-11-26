import {PDFArray,PDFDict,PDFDocument,PDFName} from 'pdf-lib';

import {prepareRetypesetFallback} from './retypesetFallback';
import {overlay} from './fixtures.test-support';
import {hex} from '../contentStreamEdit/runEncoding';

export const verticalText='日本語かな';
export async function verticalFixture(options:{text?:string;stream?:(code:(text:string)=>string)=>string;metrics?:boolean;fontData?:Uint8Array}={}){
 const doc=await PDFDocument.create(),page=doc.addPage([300,240]);
 const text=options.text??verticalText;
 const prepared=await prepareRetypesetFallback(doc,'V1','NotoSansJP-Regular.otf',Array.from(new Set(text)),{loadFont:async name=>options.fontData??new Uint8Array(await (await import('bun')).file(`src/assets/fonts/${name}`).arrayBuffer())});
 const raw=doc.context.lookup(prepared.ref,PDFDict),child=raw.lookup(PDFName.of('DescendantFonts'),PDFArray).lookup(0,PDFDict);
 raw.set(PDFName.of('Encoding'),PDFName.of('Identity-V'));
 if(options.metrics){child.set(PDFName.of('DW2'),doc.context.obj([900,-1100]));child.set(PDFName.of('W2'),doc.context.obj([1,[-1200,450,850],2,3,-1050,500,880]));}
 const code=(value:string)=>{const e=prepared.resolved.canEncode!(value);if(!e.ok)throw Error(e.reason);return hex(e.bytes);};
 const stream=options.stream?.(code)??`BT /V1 16 Tf 1 0 0 1 210 210 Tm ${code(text)} Tj ET`;
 page.node.set(PDFName.of('Resources'),doc.context.obj({Font:{V1:prepared.ref}}));
 page.node.set(PDFName.of('Contents'),doc.context.register(doc.context.stream(stream)));
 const box={x:120,y:70,w:110,h:150};
 const edit=overlay({fontSize:16,originalText:text,text:'語本日かな',rect:box,coverRects:[box]});
 return {doc,page,raw,child,code,edit};
}
