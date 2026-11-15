import {PDFDict,PDFName} from 'pdf-lib';
import {spacingPage} from './reflowApply.test-support';
export const fullReflowStream=(last='S i',left=50,first=left)=>`BT /F1 10 Tf 14 TL 1 0 0 1 ${first} 150 Tm (${first===left?'S i i i i ':'S i i i '}) Tj 1 0 0 1 ${left} 136 Tm (S i i i i ) Tj 1 0 0 1 ${left} 122 Tm (${last}) Tj ET`;
/** Preinstalled Type0 fallback uses PDF /W and a real CIDToGIDMap, never OS
 * metrics. This is also the shape of a saved substitute resource. */
export async function cidReflowPage(stream=fullReflowStream(),resource='F1'){
 const f=await spacingPage(stream),ctx=f.doc.context;
 const fonts=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict),font=fonts.lookup(PDFName.of('F1'),PDFDict);
 const map=new Uint8Array(256*2);for(const [code,gid]of [[83,1],[97,2],[110,3],[105,6],[32,4]])map[code!*2+1]=gid!;
 const cid=ctx.register(ctx.obj({Type:'Font',Subtype:'CIDFontType2',BaseFont:'Tiny',CIDSystemInfo:{Registry:'Adobe',Ordering:'Identity',Supplement:0},
  DW:500,W:[83,[1000],97,[502],110,[502]],CIDToGIDMap:ctx.register(ctx.flateStream(map)),FontDescriptor:font.get(PDFName.of('FontDescriptor'))}));
 const parent=ctx.register(ctx.obj({Type:'Font',Subtype:'Type0',BaseFont:'Tiny',Encoding:'Identity-H',DescendantFonts:[cid],
  ToUnicode:ctx.register(ctx.flateStream('1 beginbfrange <0020> <007e> <0020> endbfrange'))}));
 fonts.delete(PDFName.of('F1'));fonts.set(PDFName.of(resource),parent);
 const encoded=stream.replaceAll('/F1',`/${resource}`).replace(/\(([^()]*)\)/g,(_,s:string)=>`<${Array.from(s,c=>c.charCodeAt(0).toString(16).padStart(4,'0')).join('')}>`);
 f.page.node.set(PDFName.of('Contents'),ctx.register(ctx.flateStream(encoded)));return f;
}
export async function cffReflowPage(fontBytes:Uint8Array){
 const {PDFDocument}=await import('pdf-lib');const {prepareFallback}=await import('../contentStreamEdit/fallbackFont');
 const doc=await PDFDocument.create(),page=doc.addPage([300,200]),text='甲乙丙丁戊己庚辛';
 const prepared=await prepareFallback(doc,'F1','NotoSansSC-Regular.otf',Array.from(text),{loadFont:async()=>fontBytes});
 const encode=(s:string)=>{const r=prepared.resolved.canEncode!(s);if(!r.ok)throw Error(r.reason);return Array.from(r.bytes,b=>b.toString(16).padStart(2,'0')).join('');};
 const stream=`BT /F1 10 Tf 14 TL ${[text,text,'甲乙丙'].map((s,i)=>`1 0 0 1 50 ${150-i*14} Tm <${encode(s)}> Tj`).join(' ')} ET`;
 page.node.set(PDFName.of('Resources'),doc.context.obj({Font:{F1:prepared.ref}}));page.node.set(PDFName.of('Contents'),doc.context.register(doc.context.flateStream(stream)));
 return {doc,page,edit:{originalText:'庚',text:'甲乙',coverRects:[{x:109.9,y:148,w:10.2,h:12}]}};
}
