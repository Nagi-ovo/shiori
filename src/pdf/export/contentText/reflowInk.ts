import {PDFDict,PDFName,type PDFPage} from 'pdf-lib';
import type {ResolvedRunFont} from '../contentStreamEdit/replaceRun';
import {sourceFingerprint} from '../contentStreamEdit/replaceRun';
import {fontCoverageFromDict,fontInputFromDict} from '../fontCoverage/pdfLibAdapter';
import {readProgram} from '../fontCoverage/program';
import type {GlyphIdentity,Rect,TextTrace} from './regionProof';
import {linear,validRect,validTrace} from './regionProof/geometry';
import type {Type1Options} from '../fontCoverage/type1Support';
import fontkit from '@pdf-lib/fontkit';
/** Container metadata only: the unchanged raw CFF remains the program that
 * fontkit executes for its Bezier control hull (the same R1 program reader).
 * Nonstandard top/FD FontMatrix values need a separate transform proof. */
function cffHulls(raw:Uint8Array){
 let data=raw;
 if(raw[0]===1&&raw[2]!>=4){
  const head=new Uint8Array(54);new DataView(head.buffer).setUint16(18,1000);
  const tables:[string,Uint8Array][]=[['CFF ',raw],['head',head],['maxp',Uint8Array.of(0,0,0x50,0,0xff,0xff)]];
  data=new Uint8Array(60+tables.reduce((n,[,b])=>n+Math.ceil(b.length/4)*4,0));const v=new DataView(data.buffer);
  data.set([79,84,84,79]);v.setUint16(4,3);let offset=60;
  tables.forEach(([tag,b],i)=>{const p=12+i*16;data.set(Array.from(tag,c=>c.charCodeAt(0)),p);v.setUint32(p+8,offset);v.setUint32(p+12,b.length);data.set(b,offset);offset+=Math.ceil(b.length/4)*4;});
 }
 const font=fontkit.create(data) as ReturnType<typeof fontkit.create>&{'CFF '?:{topDict:{FontMatrix?:number[];FDArray?:{FontMatrix?:number[]}[]}}};
 const top=font['CFF ']?.topDict;
 if(!top||[top,...(top.FDArray??[])].some(d=>d.FontMatrix&&(d.FontMatrix.length!==6||d.FontMatrix.some((n,i)=>n!==[.001,0,0,.001,0,0][i]))))return;
 const u=font.unitsPerEm;if(!(u>0&&Number.isFinite(u)))return;
 return (gid:number):Rect=>{const b=font.getGlyph(gid).cbox;return {x:b.minX/u,y:b.minY/u,w:(b.maxX-b.minX)/u,h:(b.maxY-b.minY)/u};};
}
export type ReflowInk={box:Rect;glyph:GlyphIdentity;conservative:boolean};
/** Only embedded, measured fonts supply ink. TrueType uses a glyf control
 * hull. Type1 has no per-glyph hull: use the UNION of its declared program
 * FontBBox and an em envelope covering its PDF advance. This deliberately
 * refuses proportional faces whose envelopes cannot prove neighbour/row
 * clearance. Neither selection boxes nor coreQuad supply ink bounds.
 * A prepared Type0 substitute is treated identically to an embedded CID font.
 */
export function streamInkResolver(page:PDFPage,fonts:readonly ResolvedRunFont[],options:Type1Options={}){
 const dict=page.node.Resources()?.lookupMaybe(PDFName.of('Font'),PDFDict);
 const byName=new Map<string,(code:number)=>ReflowInk|undefined>();
 for(const font of fonts){
  const raw=dict?.lookupMaybe(PDFName.of(font.resourceName),PDFDict);if(!raw)continue;
  const input=fontInputFromDict(raw);if(input.error||!input.program)continue;
  const program=readProgram(input),coverage=fontCoverageFromDict(raw,options),hash=sourceFingerprint(input.program);
  if(program.kind==='fontkit'){
   const hull=program.cff?cffHulls(input.program):program.inkBox;if(!hull)continue;
   byName.set(font.resourceName,code=>{
    const gid=coverage.glyphIds.get(code.toString(16).padStart(font.bytesPerCode*2,'0'));if(!gid)return;
    const box=hull(gid);if(box&&validRect(box))return {box,glyph:{kind:'gid',programHash:hash,gid},conservative:false};
    if(/^\p{White_Space}+$/u.test(font.unicodeByCode.get(code)??''))return {box:{x:0,y:0,w:0,h:0},glyph:{kind:'gid',programHash:hash,gid},conservative:false};
   });
  }else if(program.kind==='type1'){
   const b=program.fontBBox,m=program.fontMatrix;
   if(b.length!==4||m[0]!==.001||m[1]!==0||m[2]!==0||m[3]!==.001||m[4]!==0||m[5]!==0||b.some(n=>!Number.isFinite(n))||b[2]!<b[0]!||b[3]!<b[1]!)continue;
   byName.set(font.resourceName,code=>{
    const mapping=coverage.mappings?.get(code.toString(16).padStart(font.bytesPerCode*2,'0'));
    if(!mapping||mapping.glyph.kind!=='type1-name')return;
    const proof=program.verify(mapping.glyph.name);if(!proof.ok)return;
    const width=font.widthOf(code);if(!Number.isFinite(width)||Math.abs(width-proof.width)>1)return;
    const x=Math.min(0,b[0]!/1000),y=Math.min(-.2,b[1]!/1000),right=Math.max(width/1000,b[2]!/1000),top=Math.max(.8,b[3]!/1000);
    const box=/^\p{White_Space}+$/u.test(mapping.unicode)?{x:0,y:0,w:0,h:0}:{x,y,w:right-x,h:top-y};
    return {box,glyph:mapping.glyph,conservative:true};
   });
  }
 }
 return (name:string,code:number,state:TextTrace):ReflowInk|undefined=>{
  if(!validTrace(state))return;
  const ink=byName.get(name)?.(code);if(!ink)return;
  const [a,,,d]=linear(state),sx=a!*state.size*state.tz/100,sy=d!*state.size;
  return {...ink,box:{x:ink.box.x*sx,y:ink.box.y*sy,w:ink.box.w*sx,h:ink.box.h*sy}};
 };
}
