import {PDFName} from 'pdf-lib';
import {type1Fixture} from './type1Wiring.test-support';
import {nums,widthChar} from '../fontCoverage/fixtures/type1';
import {inspectRunPage,resolveRunFonts} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {walkTextPlacements} from '../contentStreamEdit/textState';
import {streamReflowEvidence} from './reflowEvidence';
import {overlay} from './fixtures.test-support';

const rect=(advance:number,w:number)=>Uint8Array.from([...nums(0,advance),13,...nums(0,0),21,...nums(w,0),5,...nums(0,700),5,...nums(-w,0),5,9,14]);
export const texLine=(gap=300)=>`BT /F1 10 Tf 14 TL 50 100 Td [${Array(7).fill('(AAA)').join(` -${gap} `)}] TJ ET`;
export const glueEdit=()=>overlay({originalText:'A',text:'Ai',coverRects:[{x:49.99,y:99.9,w:6,h:7.2}]});
export async function glueFixture(options:{stream?:string;rowLocal?:boolean;annotation?:number[];spaceInk?:boolean}={}){
 const prefix=options.rowLocal?'BT /F1 10 Tf 14 TL 50 109.9 Td (A) Tj ET ':'';
 const f=await type1Fixture({stream:prefix+(options.stream??texLine()),programOptions:{glyphs:{
  '.notdef':widthChar(0),A:rect(600,300),i:rect(280,100),space:options.spaceInk?rect(300,100):widthChar(300),
 }}}),ctx=f.doc.context;
 const widths=Array(74).fill(600);widths[0]=300;widths[105-32]=280;
 f.font.set(PDFName.of('FirstChar'),ctx.obj(32));f.font.set(PDFName.of('LastChar'),ctx.obj(105));
 f.font.set(PDFName.of('Widths'),ctx.obj(widths));
 f.font.set(PDFName.of('Encoding'),ctx.obj({Differences:[32,'space',65,'A',105,'i']}));
 f.font.set(PDFName.of('ToUnicode'),ctx.register(ctx.flateStream('3 beginbfchar <20> <0020> <41> <0041> <69> <0069> endbfchar')));
 if(options.annotation)f.page.node.set(PDFName.of('Annots'),ctx.obj([ctx.register(ctx.obj({Type:'Annot',Subtype:'Link',Rect:options.annotation}))]));
 const s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);
 const fonts=resolveRunFonts(f.page),ops=tokenizeContentStream(s.bytes),target=ops.findIndex(o=>o.operator==='TJ'||o.operator==='Tj'&&!options.rowLocal);
 const e=streamReflowEvidence(f.page,s.bytes,fonts,target);
 return {...f,s,fonts,e,edit:glueEdit()};
}
export function readGlue(bytes:Uint8Array,fonts:ReturnType<typeof resolveRunFonts>){
 const w=walkTextPlacements(tokenizeContentStream(bytes),{resolveFont:name=>{
  const f=fonts.find(f=>f.resourceName===name);return f?{...f,ok:true,appliesWordSpacing:f.bytesPerCode===1}:null;
 }});if(!w.ok)throw Error(w.reason);return w.glyphs;
}
