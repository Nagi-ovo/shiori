import {PDFDict,PDFName,type PDFDocument,type PDFPage} from 'pdf-lib';
import {encodeRun} from '../contentStreamEdit/runEncoding';
import type {FallbackOptions} from '../contentStreamEdit/fallbackFont';
import type {ContentOp} from '../contentStreamEdit/tokenizer';
import type {GlyphPlacement} from '../contentStreamEdit/textState';
import type {ResolvedRunFont} from '../contentStreamEdit/replaceRun';
import {fontRequestsForParagraph,forRegionalVerticalFace,genericFontForFit,resolveFont,withCachedLocalFonts,type FontChoice} from '../fonts/fontService';
import {fontChoiceKey} from '../fonts/localFonts';
import {sourceFontReader} from '../fonts/sourceFontContext';
import {prepareRetypesetFallback} from './retypesetFallback';
import {retypesetFontSelector} from './retypesetFontSelection';
import type {RetypesetCluster} from './retypesetTypes';
import {requiresVerticalAlternate,uprightNominal} from './uprightColumnGlyphs';

type Glyph = Pick<GlyphPlacement,'fontName'|'opIndex'>;
type Hole = {text:string;home:{glyph:Glyph}};

export function retypesetFontGroups(page:PDFPage,ops:ContentOp[],scratch:PDFDocument,fonts:ResolvedRunFont[],
 options:FallbackOptions,purpose:'retypeset'|'vertical',resourcePrefix:string,
 select=retypesetFontSelector(options)){
 const upright=purpose==='vertical';
 const fontOptions=withCachedLocalFonts(options);
 const read=sourceFontReader(page,ops);
 let hasFitAlternative=false;
 const dict=page.node.Resources()?.lookupMaybe(PDFName.of('Font'),PDFDict);
 const used=new Set(fonts.map(f=>f.resourceName));
 const prepared:{p:Awaited<ReturnType<typeof prepareRetypesetFallback>>;name:string}[]=[];
 const checkAlternate=(c:string,parsed:Parameters<typeof requiresVerticalAlternate>[1])=>{
  if(!uprightNominal(c)&&requiresVerticalAlternate(c,parsed))throw Error(`vertical-glyph: ${JSON.stringify(c)} needs a vertical alternate that no source column shows`);
 };
 const fill=async<T extends Hole>(missing:readonly T[],paragraph:string,useGeneric=false)=>{
  const assigned=new Map<T,ResolvedRunFont>();
  hasFitAlternative=false;
  if(!missing.length)return assigned;
  const withParagraph=fontRequestsForParagraph(paragraph);
  const groups=new Map<ReturnType<typeof fontChoiceKey>,{face:FontChoice;items:T[]}>();
  for(const item of missing){
   const {fontName,opIndex}=item.home.glyph;
   const request=withParagraph({...read(fontName,opIndex),purpose,text:item.text});
   let primary=resolveFont(request,fontOptions);
   // Upright cells take their position from the page. A Latin face is
   // usable here when it has the glyph. Route a neutral cmap gap by region.
   if(upright&&!primary.region&&primary.source==='bundled'&&!(await select.covers(primary,item.text))){
    primary=resolveFont(forRegionalVerticalFace(request),fontOptions);
   }
   const generic=genericFontForFit(request,primary);
   hasFitAlternative ||= !!generic;
   const face=useGeneric&&generic?generic:primary;
   const key=fontChoiceKey(face);
   const group=groups.get(key)??{face,items:[]};
   group.items.push(item);groups.set(key,group);
  }
  for(const {face:primary,items}of groups.values())for(const {face,name,data,parsed,clusters}of await select(primary,paragraph,items.map(a=>a.text),upright)){
   if(upright)for(const c of clusters)checkAlternate(c,parsed);
   let i=1,resource:string;
   do{resource=`${resourcePrefix}${i++}`;}while(used.has(resource)||dict?.has(PDFName.of(resource)));
   used.add(resource);
   const p=await prepareRetypesetFallback(scratch,resource,face,clusters,{loadFont:async()=>data});
   prepared.push({p,name});fonts.push(p.resolved);
   const covered=new Set(clusters);
   for(const a of items)if(covered.has(a.text.normalize('NFC')))assigned.set(a,p.resolved);
  }
  return assigned;
 };
 return {prepared,fill, get hasFitAlternative(){return hasFitAlternative;}};
}

export async function encodeRetypesetClusters(output:readonly RetypesetCluster[],paragraph:string,fonts:ResolvedRunFont[],
 groups:ReturnType<typeof retypesetFontGroups>,useGeneric:boolean){
 const missing:RetypesetCluster[]=[];
 for(const a of output){
  if(a.hard)continue;
  const font=fonts.find(f=>f.resourceName===a.home.glyph.fontName)!;
  if(a.bytes){a.font=font;continue;}
  try{const encoded=encodeRun(a.text,font,new Uint8Array());if(encoded.ok){a.bytes=encoded.bytes;a.font=font;continue;}}catch{ /* approximate substitute below */ }
  missing.push(a);
 }
 const start=groups.prepared.length;
 for(const [a,font]of await groups.fill(missing,paragraph,useGeneric)){
  const encoded=encodeRun(a.text,font,new Uint8Array());
  if(!encoded.ok)throw Error('substitute cannot encode replacement');
  a.bytes=encoded.bytes;a.font=font;
 }
 const names=new Set(groups.prepared.slice(start).map(({name})=>name));
 return names.size?[...names].join(', '):null;
}
