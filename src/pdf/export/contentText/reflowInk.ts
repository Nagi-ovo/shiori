import {PDFArray,PDFDict,PDFName,type PDFPage} from 'pdf-lib';
import type {ResolvedRunFont} from '../contentStreamEdit/replaceRun';
import {sourceFingerprint} from '../contentStreamEdit/replaceRun';
import {fontCoverageFromDict,fontInputFromDict} from '../fontCoverage/pdfLibAdapter';
import {readProgram} from '../fontCoverage/program';
import type {GlyphIdentity,Rect,TextTrace} from './regionProof';
import {linear,validRect,validTrace} from './regionProof/geometry';
import type {Type1Options} from '../fontCoverage/type1Support';
import fontkit from '@pdf-lib/fontkit';
import {createFontCoverage} from '../fontCoverage/coverage';
import {runToUnicode} from '../contentStreamEdit/runToUnicode';
import {numericArray} from './reflowScene';
import {simpleNames} from '../fontCoverage/encodings';
import {proveType3Glyph} from '../fontCoverage/type3Proof';
/** Container metadata only: the unchanged raw CFF remains the program that
 * fontkit executes for its Bezier control hull (the same R1 program reader).
 * Transform the control hull with the top FontMatrix; FD-local transforms
 * remain unsupported rather than silently assuming an identity. */
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
 if(!top||(top.FDArray??[]).some(d=>d.FontMatrix))return;
 const m=top.FontMatrix??[.001,0,0,.001,0,0];
 if(m.length!==6||!m.every(Number.isFinite))return;
 return (gid:number):Rect=>{
  const glyph=font.getGlyph(gid);if(!glyph.path.toSVG())return {x:0,y:0,w:0,h:0};const b=glyph.cbox;
  const points=[[b.minX,b.minY],[b.maxX,b.minY],[b.maxX,b.maxY],[b.minX,b.maxY]].map(([x,y])=>
   [m[0]!*x!+m[2]!*y!+m[4]!,m[1]!*x!+m[3]!*y!+m[5]!]);
  const xs=points.map(p=>p[0]!),ys=points.map(p=>p[1]!);
  return {x:Math.min(...xs),y:Math.min(...ys),w:Math.max(...xs)-Math.min(...xs),h:Math.max(...ys)-Math.min(...ys)};
 };
}
export type ReflowInk={box:Rect;glyph?:GlyphIdentity;conservative:boolean};
/** Outlines are preferred; a declared PDF FontBBox is conservative ink,
 * independent of source encoding eligibility. No selection, advance or em
 * metric can fill a missing envelope. Unproved composites stay unknown. */
export function streamInkResolver(page:PDFPage,fonts:readonly ResolvedRunFont[],options:Type1Options={},_addressOnly=false){
 void _addressOnly;
 const dict=page.node.Resources()?.lookupMaybe(PDFName.of('Font'),PDFDict);
 const byName=new Map<string,(code:number)=>ReflowInk|undefined>();

 for(const font of fonts){
  const raw=dict?.lookupMaybe(PDFName.of(font.resourceName),PDFDict);if(!raw)continue;
  const child=raw.lookupMaybe(PDFName.of('DescendantFonts'),PDFArray)?.lookup(0,PDFDict),descriptor=(child??raw).lookupMaybe(PDFName.of('FontDescriptor'),PDFDict);
  const matrix=numericArray(raw,'FontMatrix');
  if(matrix&&(matrix.length!==6||matrix.some((n,i)=>n!==[.001,0,0,.001,0,0][i])))continue;
  const declared=numericArray(raw,'FontBBox')??(descriptor?numericArray(descriptor,'FontBBox'):undefined);
  const envelope=declared?.length===4&&declared.every(Number.isFinite)&&declared[2]!>=declared[0]!&&declared[3]!>=declared[1]!
   ?{x:declared[0]!/1000,y:declared[1]!/1000,w:(declared[2]!-declared[0]!)/1000,h:(declared[3]!-declared[1]!)/1000}:undefined;
  const fallback=():ReflowInk|undefined=>envelope?{box:envelope,conservative:true}:undefined;
  // A declaration bounds source paint even when an unsupported dictionary
  // idiom prevents program reuse. The encoder retains its independent gate.
  byName.set(font.resourceName,fallback);
  const input=fontInputFromDict(raw);
  if(input.subtype==='Type3'){
   byName.set(font.resourceName,code=>{const p=proveType3Glyph(input,code);return p.ok?{box:p.proof.inkBounds??{x:0,y:0,w:0,h:0},conservative:false}:undefined;});
   continue;
  }
  if(input.error||!input.program)continue;
  let program:ReturnType<typeof readProgram>;
  try{program=readProgram(input);}catch{continue;}
  const coverage=input.toUnicode&&!runToUnicode(input.toUnicode,font.bytesPerCode)&&font.bytesPerCode===1&&input.encoding?
   createFontCoverage({...input,toUnicode:undefined},options):fontCoverageFromDict(raw,options),hash=sourceFingerprint(input.program);
  if(program.kind==='fontkit'){
   let hull:((gid:number)=>Rect|undefined)|undefined;
   try{hull=program.cff?cffHulls(input.program):program.inkBox;}catch{continue;}if(!hull)continue;
   byName.set(font.resourceName,code=>{
    const gid=coverage.glyphIds.get(code.toString(16).padStart(font.bytesPerCode*2,'0'));if(!gid)return fallback();
    let box:Rect|undefined;try{box=hull(gid);}catch{return fallback();}if(box&&validRect(box))return {box,glyph:{kind:'gid',programHash:hash,gid},conservative:false};
    return fallback();
   });
  }else if(program.kind==='type1'){
   const m=program.fontMatrix;
   if(m.length!==6||m.some((n,i)=>n!==[.001,0,0,.001,0,0][i])){byName.delete(font.resourceName);continue;}
   let names:ReadonlyMap<number,string>;try{names=simpleNames(input,program.builtIn);}catch{continue;}
   byName.set(font.resourceName,code=>{
    const name=names.get(code);if(!name)return;
    const proof=program.verify(name);if(!proof.ok||proof.inkBounds===undefined)return;
    const hull=proof.inkBounds;
    const box=hull===null?{x:0,y:0,w:0,h:0}:{x:hull.x/1000,y:hull.y/1000,w:hull.w/1000,h:hull.h/1000};
    return {box,glyph:{kind:'type1-name',programHash:hash,name},conservative:false};
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
