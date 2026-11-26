import fontkit from '@pdf-lib/fontkit';
import type {PDFPage} from 'pdf-lib';
import {loadFallbackFont,type FallbackOptions} from '../contentStreamEdit/fallbackFont';
import {fallbackClusters} from '../contentStreamEdit/fallbackClusters';
import {RunCompileError} from '../contentStreamEdit/runRefusal';
import {resolveFont,type FontChoice} from '../fonts/fontService';
import {fontChoiceKey} from '../fonts/localFonts';
import {sourceFontReader} from '../fonts/sourceFontContext';

export function originalFallbackFace(page:PDFPage,resource:string,text:string){
 return resolveFont({...sourceFontReader(page,[])(resource,0),purpose:'retypeset',text}).name;
}

/** Inspect cmap coverage before embedding. First prefer one face covering all
 * missing output; if none does, retain the writer's existing per-cluster font
 * machinery. A paragraph containing CJK never admits a Liberation candidate.
 * Original encodable clusters remain in their source fonts. */
export function retypesetFontSelector(options:FallbackOptions){
 const key=(face:string|FontChoice)=>typeof face==='string'?face:fontChoiceKey(face);
 const loaded=new Map<ReturnType<typeof key>,Promise<{data:Uint8Array;parsed:ReturnType<typeof fontkit.create>}>>();
 const load=(face:string|FontChoice)=>{
  const id=key(face);
  let pending=loaded.get(id);
  if(!pending){pending=loadFallbackFont(face,options).then(data=>({data,parsed:fontkit.create(data)}));loaded.set(id,pending);}
  return pending;
 };
 const covers=(parsed:ReturnType<typeof fontkit.create>,cluster:string)=>
  Array.from(cluster.normalize('NFC')).every(c=>parsed.glyphForCodePoint(c.codePointAt(0)!).id!==0);
 const candidateFor=async(face:string|FontChoice,needed:readonly string[])=>{
  const {data,parsed}=await load(face);
  return {face,name:typeof face==='string'?face:face.name,data,parsed,clusters:needed.filter(c=>covers(parsed,c))};
 };
 const select=async(primary:string|FontChoice,paragraph:string,clusters:readonly string[],upright=false)=>{
  const primaryKey=key(primary);
  const name=typeof primary==='string'?primary:primary.name;
  const cjk=typeof primary==='string'
   ?/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(paragraph)
   :!!primary.region;
  const regular=['NotoSansJP-Regular.otf','NotoSansSC-Regular.otf','NotoSansKR-Regular.otf'];
  const bold=typeof primary==='string'?name.endsWith('-Bold.otf'):primary.style.startsWith('Bold');
  const primaryRegular=typeof primaryKey==='string'&&regular.find(n=>n.replace('-Regular','-Bold')===name);
  const cjkFaces=bold
   ?[...regular.map(n=>n.replace('-Regular','-Bold')),...(primaryRegular?[primaryRegular]:[]),...regular]
   :regular;
  const alternatives=[...(cjk?cjkFaces:[]),'NotoSansMath-Regular.ttf','NotoSansSymbols2-Regular.ttf',
   ...(!cjk?['NotoSansSC-Regular.otf','NotoSansJP-Regular.otf','NotoSansKR-Regular.otf']:[])];
  const faces=[...(upright?[]:[primary]),...new Set(alternatives.filter(n=>n!==primaryKey))];
  let needed=[...new Set(clusters.flatMap(fallbackClusters))];
  const candidates=[],groups=[];
  if(upright){
   // A glyph the primary can draw has to pass its alternate proof even if
   // another face could cover more of the column.
   const first=await candidateFor(primary,needed);
   if(first.clusters.length===needed.length)return [first];
   if(first.clusters.length)groups.push(first);
   const covered=new Set(first.clusters);
   needed=needed.filter(c=>!covered.has(c));
  }
  for(const face of faces){
   if(cjk&&(typeof face==='string'?face.startsWith('Liberation'):face.source==='bundled'&&face.family.startsWith('Liberation')))continue;
   const candidate=await candidateFor(face,needed);
   if(candidate.clusters.length===needed.length)return [...groups,candidate];
   candidates.push(candidate);
  }
  const remaining=new Set(needed);
  for(const candidate of candidates){
   const assigned=candidate.clusters.filter(c=>remaining.has(c));
   if(assigned.length){groups.push({...candidate,clusters:assigned});for(const c of assigned)remaining.delete(c);}
  }
  if(remaining.size)throw new RunCompileError(`unsupported fallback missing glyph after coverage chain: ${[...remaining].join(' ')}`,'font-coverage');
  return groups;
 };
 return Object.assign(select,{
  covers:async(face:FontChoice,cluster:string)=>covers((await load(face)).parsed,cluster),
 });
}
