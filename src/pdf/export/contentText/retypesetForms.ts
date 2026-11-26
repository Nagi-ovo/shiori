import {PDFArray,PDFDict,PDFName,PDFNumber,PDFPage,PDFRawStream,decodePDFRawStream} from 'pdf-lib';
import type {PdfRect} from '../../model/types';
import type {Type1Options} from '../fontCoverage/type1Support';
import type {TextGraphicsState} from '../contentStreamEdit/textGraphicsState';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream,type ContentOp} from '../contentStreamEdit/tokenizer';
import {quadIntersectsRect} from '../contentStreamEdit/removeGlyphs';
import type {GlyphPlacement,Point} from '../contentStreamEdit/textState';
import {readRetypesetSource} from './retypesetSource';
import type {RetypesetGlyph} from './retypesetTypes';
import {retypesetScopes} from './retypesetScopes';
import {contains} from './regionProof/geometry';
import {preserveSourceFontPage,sourceFontReader} from '../fonts/sourceFontContext';

export type FormMatrix=readonly number[];
export const identity=[1,0,0,1,0,0];
/** Composition: local b, then outer a. */
export const composeFormMatrix=(a:FormMatrix,b:FormMatrix)=>[
 a[0]!*b[0]!+a[2]!*b[1]!,a[1]!*b[0]!+a[3]!*b[1]!,a[0]!*b[2]!+a[2]!*b[3]!,a[1]!*b[2]!+a[3]!*b[3]!,
 a[0]!*b[4]!+a[2]!*b[5]!+a[4]!,a[1]!*b[4]!+a[3]!*b[5]!+a[5]!,
];
const point=(m:FormMatrix,p:Point)=>({x:m[0]!*p.x+m[2]!*p.y+m[4]!,y:m[1]!*p.x+m[3]!*p.y+m[5]!});
const quad=(m:FormMatrix,q:GlyphPlacement['quad'])=>q.map(p=>point(m,p)) as GlyphPlacement['quad'];
function inverse(m:FormMatrix){
 const d=m[0]!*m[3]!-m[1]!*m[2]!;if(!Number.isFinite(d)||Math.abs(d)<1e-10)throw Error('singular Form transform');
 return [m[3]!/d,-m[1]!/d,-m[2]!/d,m[0]!/d,(m[2]!*m[5]!-m[3]!*m[4]!)/d,(m[1]!*m[4]!-m[0]!*m[5]!)/d];
}
export function formPageBox(m:FormMatrix,r:PdfRect):PdfRect{
 const ps=quad(m,[{x:r.x,y:r.y},{x:r.x+r.w,y:r.y},{x:r.x+r.w,y:r.y+r.h},{x:r.x,y:r.y+r.h}]);
 const x=Math.min(...ps.map(p=>p.x)),y=Math.min(...ps.map(p=>p.y));return{x,y,w:Math.max(...ps.map(p=>p.x))-x,h:Math.max(...ps.map(p=>p.y))-y};
}
type Clip={inverse:FormMatrix;box:PdfRect};
type PushClip={inverse:FormMatrix;box:PdfRect|null;reason:string};
export type RetypesetPushSpace={box:PdfRect;blocked:(destination:PdfRect)=>string|undefined};
// Only occurrence pages prepared here may push a Form. A raw shared stream
// passed directly to the writer has no entry, even if it has a valid BBox.
const cowPushSpaces=new WeakMap<PDFPage,{contents:PDFRawStream;space:RetypesetPushSpace}>();
export function retypesetFormPushSpace(page:PDFPage){
 const entry=cowPushSpaces.get(page);
 return entry&&page.node.get(PDFName.of('Contents'))===entry.contents?entry.space:undefined;
}
export type RetypesetStream={
 key:string;page:PDFPage;bytes:Uint8Array;ops:ContentOp[];read:ReturnType<typeof readRetypesetSource>;
 matrix:FormMatrix;clips:Clip[];children:RetypesetStream[];raw?:PDFRawStream;useIndex?:number;changed:boolean;
};
function detachedPage(page:PDFPage,resources:PDFDict|undefined,formPath:readonly string[],raw?:PDFRawStream,invocationLang?:string){
 const node=page.node.clone();node.set(PDFName.of('Resources'),resources??page.doc.context.obj({}));
 if(raw){
  node.set(PDFName.of('Contents'),raw.clone());
  // This page is only a stream/resource adapter, in Form user space. Page
  // annotations and page boxes are not occupants/bounds inside the Form.
  node.set(PDFName.of('MediaBox'),raw.dict.get(PDFName.of('BBox'))!);
  node.set(PDFName.of('CropBox'),raw.dict.get(PDFName.of('BBox'))!);
  node.delete(PDFName.of('Annots'));
 }
 const detached=PDFPage.of(node,page.ref,page.doc);
 preserveSourceFontPage(detached,page,{formPath,invocationLang,resources:detached.node.Resources()});
 return detached;
}
function numbers(raw:PDFRawStream,key:string){
 return raw.dict.lookupMaybe(PDFName.of(key),PDFArray)?.asArray().map(n=>{const v=raw.dict.context.lookup(n);return v instanceof PDFNumber?v.asNumber():NaN;});
}
/** One node per Do occurrence, never per indirect object. Addresses remain
 * local to the stream; only selection/manifest geometry is mapped to the page. */
export function readRetypesetStreams(page:PDFPage,options:Type1Options={}){
 const source=inspectRunPage(page);if(!source.ok)throw Error(source.reason);
 const nodes:RetypesetStream[]=[],errors:string[]=[],images:{matrix:FormMatrix}[]=[];
 const visit=(localPage:PDFPage,bytes:Uint8Array,key:string,matrix:FormMatrix,clips:Clip[],ancestors:Set<PDFRawStream>,pushClips:PushClip[],formPath:readonly string[],initial?:TextGraphicsState):RetypesetStream=>{
  if(nodes.length>=1024)throw Error('Form occurrence limit exceeded');
  const ops=tokenizeContentStream(bytes),read=readRetypesetSource(localPage,ops,options,initial);
  const node:RetypesetStream={key,page:localPage,bytes,ops,read,matrix,clips,children:[],changed:false};nodes.push(node);
  if(!read.walk.ok){errors.push(`${key}: ${read.walk.reason}`);return node;}
  const objects=localPage.node.Resources()?.lookupMaybe(PDFName.of('XObject'),PDFDict);
  const scopes=retypesetScopes(ops);
  let readFont:ReturnType<typeof sourceFontReader>|undefined;
  for(const image of read.walk.inlineImages)images.push({matrix:composeFormMatrix(matrix,image.ctm)});
  for(const [index,use]of read.walk.xobjects.entries())try{
   const raw=objects?.lookup(PDFName.of(use.name));if(!(raw instanceof PDFRawStream))throw Error(`unreadable XObject /${use.name}`);
   const subtype=raw.dict.lookupMaybe(PDFName.of('Subtype'),PDFName)?.decodeText(),ctm=composeFormMatrix(matrix,use.ctm);
   if(subtype==='Image'){images.push({matrix:ctm});continue;}if(subtype!=='Form')continue;
   if(ancestors.has(raw)||ancestors.size>=24)throw Error('cyclic or too deeply nested Form');
   const box=numbers(raw,'BBox'),m=numbers(raw,'Matrix')??identity;
   if(!box||box.length!==4||m.length!==6||![...box,...m].every(Number.isFinite)||box[2]!<=box[0]!||box[3]!<=box[1]!)throw Error('invalid Form BBox/Matrix');
   const combined=composeFormMatrix(ctm,m),clip:Clip={inverse:inverse(combined),box:{x:box[0]!,y:box[1]!,w:box[2]!-box[0]!,h:box[3]!-box[1]!}};
   const parent=localPage.node.Resources(),resources=raw.dict.lookupMaybe(PDFName.of('Resources'),PDFDict)??parent;
   const state={...read.invocations.get(use.opIndex)!,ctm:[...identity] as TextGraphicsState['ctm']};
   // A font is an inherited object, not a name looked up anew in the form.
   // Fail closed until a local Tf if the same name resolves differently.
   if(state.fontName){
    const font=(r:PDFDict|undefined)=>r?.lookupMaybe(PDFName.of('Font'),PDFDict)?.lookup(PDFName.of(state.fontName!));
    if(font(resources)!==font(parent))state.fontTainted=true;
   }
   const data=raw.dict.has(PDFName.of('Filter'))?decodePDFRawStream(raw).decode():raw.getContents();
   const active=scopes.get(use.opIndex)?.clip,childClips=[...pushClips,{...clip,reason:'form-bbox'},
    ...(active===undefined?[]:[{inverse:inverse(matrix),box:active,reason:'form-clip'}])];
   const childPath=[...formPath,use.name];
   readFont??=sourceFontReader(localPage,ops);
   const detached=detachedPage(page,resources,childPath,raw,readFont.languageAt(use.opIndex));
   const child=visit(detached,data,`${key}/${use.opIndex}`,combined,[...clips,clip],new Set([...ancestors,raw]),childClips,childPath,state);
   child.raw=raw;child.useIndex=index;node.children.push(child);
   const contents=child.page.node.get(PDFName.of('Contents'));
   if(contents instanceof PDFRawStream&&contents!==raw&&contents.dict!==raw.dict)cowPushSpaces.set(child.page,{contents,space:{box:clip.box,
    blocked:destination=>childClips.find(c=>c.box===null||!contains(c.box,formPageBox(composeFormMatrix(c.inverse,combined),destination)))?.reason,
   }});
  }catch(error){errors.push(`${key}/${use.opIndex}: ${String(error)}`);}
  return node;
 };
 const m=page.getMediaBox(),c=page.getCropBox(),x=Math.max(m.x,c.x),y=Math.max(m.y,c.y);
 const pageBox={x,y,w:Math.max(0,Math.min(m.x+m.width,c.x+c.width)-x),h:Math.max(0,Math.min(m.y+m.height,c.y+c.height)-y)};
 const root=visit(detachedPage(page,page.node.Resources(),[]),source.bytes,'page',identity,[],new Set(),[{inverse:identity,box:pageBox,reason:'crop-media-box'}],[]);
 return {root,nodes,errors,images};
}
export function pageFormGlyphs(node:RetypesetStream,clipped=true):RetypesetGlyph[]{
 return node.read.glyphs.map(g=>{
  const p=point(node.matrix,{x:g.x,y:g.y});return{...g,...p,glyph:{...g.glyph,quad:quad(node.matrix,g.glyph.quad),coreQuad:quad(node.matrix,g.glyph.coreQuad)}};
 }).filter(g=>!clipped||node.clips.every(c=>quadIntersectsRect(quad(c.inverse,g.glyph.coreQuad),c.box)));
}
