import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {PDFDocument,PDFDict,PDFName,PDFRawStream,PDFRef,decodePDFRawStream} from 'pdf-lib';
import {createHash} from 'node:crypto';
import {fontCoverageFromDict} from '../../src/pdf/export/fontCoverage/pdfLibAdapter';
import type {Type1Options} from '../../src/pdf/export/fontCoverage/type1Support';
import {notdefProbePdf} from '../pdf-inplace/notdefProbe';
import {assertReplacementGlyphs,assertNativeReplacementGlyphs} from '../pdf-inplace/glyphEvidence';
import type {openPdfium} from '../pdf-inplace/nativePdfium';
import {compareReflowNativePages} from './reflowOracle';
import {saveReflowVetoArtifact} from './reflowVetoArtifact';
import {backdropReferencePdf} from './reflowBackdropRaster';
import {inspectRunPage} from '../../src/pdf/export/contentStreamEdit/replaceRunPage';
import type {AppliedReflowManifest} from '../../src/pdf/export/contentText/reflowManifest';
import type {PdfRect} from '../../src/pdf/model/types';
import type {ContentTextOutcome} from '../../src/pdf/export/contentText/outcomes';
import {compareRetypesetNativePages} from './retypesetOracle';
import {assertRetypesetStreamIdentity,retypesetSourceOwnership} from './retypesetStreamOracle';
import {retypesetFontObjects,retypesetNotdefProbePdf} from './retypesetFontProbe';
import {auditQpdfPair} from './qpdfOracle';
import {assertRetypesetPopplerText} from './retypesetPoppler';
import {compareRetypesetFormWalk} from './retypesetFormWalkOracle';
const compact=(s:string)=>s.replace(/\s/gu,'');
type Glyph={text:string;origin:readonly number[];box:readonly number[];fontHash?:string;nativePath?:unknown;inkPixels?:number;fontSize?:number};
type Snapshot={width:number;height:number;text:string;glyphs:readonly Glyph[];pixels?:Uint8Array};
type Edit={originalText:string;text:string;coverRects:readonly PdfRect[]};
function whitespaceGaps(glyphs:readonly Glyph[]){
 const gaps:Glyph[][]=[[]];
 for(const glyph of glyphs){if(compact(glyph.text))gaps.push([]);else gaps.at(-1)!.push(glyph);}
 return gaps;
}
export function expectedPopplerText(before:string,edit:Pick<Edit,'originalText'|'text'>){
 const source=compact(before),lines=edit.originalText.split('\n'),replacement=edit.text.split('\n');
 assert.equal(lines.length,replacement.length,'Poppler audit requires unchanged line breaks');
 let cursor=0,expected='';
 for(let line=0;line<lines.length;line++){
  const original=compact(lines[line]!);assert(original,'Poppler audit requires a nonempty source line');
  const at=source.indexOf(original,cursor);assert(at>=0,'Poppler baseline source mismatch');
  expected+=source.slice(cursor,at)+compact(replacement[line]!);cursor=at+original.length;
 }
 return expected+source.slice(cursor);
}
/** Independent native expected sequence; original prefix/suffix glyphs retain
 * native font-program identity and positions. No compiler widths are used. */
export function compareNativePages(before:Snapshot,after:Snapshot,edit:Edit,substituted=false){
 const old=before.glyphs.filter(g=>compact(g.text)),actual=after.glyphs.filter(g=>compact(g.text));
 const covered=old.map((g,i)=>({g,i})).filter(({g})=>edit.coverRects.some(r=>g.origin[0]!>=r.x-.01 && g.origin[0]!<=r.x+r.w+.01 && g.origin[1]!>=r.y-.01 && g.origin[1]!<=r.y+r.h+.01));
 assert(covered.length,'native edit box selects no text');
 assert.equal(compact(covered.map(({g})=>g.text).join('')),compact(edit.originalText),'native selected source text differs');
 for(const g of [...old,...actual])assert.equal(Array.from(g.text).length,1,'native audit requires one glyph per Unicode scalar');
 const sourceLines=edit.originalText.split('\n'),replacementLines=edit.text.split('\n');
 assert.equal(sourceLines.length,replacementLines.length,'native audit requires unchanged line breaks');
 const expected:({text:string;original?:Glyph;originAnchor?:Glyph;sizeAnchor?:number})[]=old.map(g=>({text:g.text,original:g}));
 let cursor=covered.length;
 // Work backwards by source line: other columns/objects can be interleaved
 // between selected lines in native extraction order and must stay untouched.
 for(let line=sourceLines.length-1;line>=0;line--){
  const length=Array.from(compact(sourceLines[line]!)).length,selected=covered.slice(cursor-length,cursor);cursor-=length;
  assert(selected.length,'native audit requires a nonempty source line');
  assert.equal(selected.map(({g})=>g.text).join(''),compact(sourceLines[line]!),'native selected line differs');
  assert(selected.every(({i},n)=>i===selected[0]!.i+n),'native source line has interleaved glyphs');
  const replacement=Array.from(compact(replacementLines[line]!));let prefixCount=0,suffixCount=0;
  while(!substituted && prefixCount<selected.length && prefixCount<replacement.length && selected[prefixCount]!.g.text===replacement[prefixCount])prefixCount++;
  while(!substituted && suffixCount<selected.length-prefixCount && suffixCount<replacement.length-prefixCount && selected[selected.length-1-suffixCount]!.g.text===replacement[replacement.length-1-suffixCount])suffixCount++;
  expected.splice(selected[0]!.i+prefixCount,selected.length-prefixCount-suffixCount,...replacement.slice(prefixCount,replacement.length-suffixCount).map((text,i)=>({text,
   ...(substituted?{sizeAnchor:selected[0]!.g.fontSize,...(i===0?{originAnchor:selected[0]!.g}:{})}:{})})));
 }
 assert.equal(cursor,0,'native selected glyphs remain unaccounted');
 assert.equal(compact(after.text),expected.map(g=>g.text).join(''),'native extracted text mismatch');
 assert.equal(actual.length,expected.length,'native glyph count mismatch');
 let maxOriginDriftPt=0,replacementGlyphs=0;const replacementIndices:number[]=[];
 actual.forEach((g,i)=>{const e=expected[i]!;assert.equal(g.text,e.text,'native glyph Unicode/order mismatch');
  if(e.originAnchor)assert(Math.hypot(g.origin[0]!-e.originAnchor.origin[0]!,g.origin[1]!-e.originAnchor.origin[1]!)<=.01,'substitute first glyph origin changed');
  if(e.sizeAnchor!==undefined)assert(g.fontSize!==undefined&&Math.abs(g.fontSize-e.sizeAnchor)<=.01,'substitute font size changed');
  if(e.original){assert.equal(g.fontHash,e.original.fontHash,'untouched font program changed');const drift=Math.hypot(g.origin[0]!-e.original.origin[0]!,g.origin[1]!-e.original.origin[1]!);maxOriginDriftPt=Math.max(maxOriginDriftPt,drift);assert(drift<=.01,`untouched glyph drift ${drift}`);}
  else{replacementGlyphs++;replacementIndices.push(i);assert(g.nativePath && (g.nativePath as unknown[]).length,'replacement path missing');assert((g.inkPixels??0)>0,'replacement has no ink');}
 });
 // Real space glyphs carry advance/origin evidence even though they have no
 // ink. Anchor each unchanged gap to surviving native neighbours; a gap whose
 // two neighbours were replaced belongs to the edited scalar span instead.
 const originalPositions=new Map(expected.flatMap((e,i)=>e.original?[[e.original,i] as const]:[]));
 const beforeGaps=whitespaceGaps(before.glyphs),afterGaps=whitespaceGaps(after.glyphs);
 beforeGaps.forEach((spaces,gap)=>{
  if(!spaces.length)return;
  const left=old[gap-1],right=old[gap],leftAt=left?originalPositions.get(left):undefined,rightAt=right?originalPositions.get(right):undefined;
  const at=leftAt!==undefined?leftAt+1:rightAt;
  if(at===undefined)return;
  const observed=afterGaps[at]??[];assert.equal(observed.length,spaces.length,'untouched native whitespace count changed');
  spaces.forEach((space,i)=>{const g=observed[i]!;assert.equal(g.text,space.text,'untouched native whitespace changed');assert.equal(g.fontHash,space.fontHash,'untouched whitespace font program changed');
   const drift=Math.hypot(g.origin[0]!-space.origin[0]!,g.origin[1]!-space.origin[1]!);maxOriginDriftPt=Math.max(maxOriginDriftPt,drift);assert(drift<=.01,`untouched whitespace drift ${drift}`);
  });
 });
 assert(before.pixels && after.pixels,'native raster missing');assert.equal(before.pixels.length,after.pixels.length);
 const width=Math.round(before.width*2),height=Math.round(before.height*2);let changedPixels=0,changedPixelsOutsideBox=0;
 for(let offset=0;offset<before.pixels.length;offset+=4){if(before.pixels.subarray(offset,offset+4).every((b,i)=>b===after.pixels![offset+i]))continue;
  changedPixels++;const p=offset/4,x=(p%width+.5)/2,y=(height-Math.floor(p/width)-.5)/2;
  if(!edit.coverRects.some(r=>x>=r.x && x<=r.x+r.w && y>=r.y && y<=r.y+r.h))changedPixelsOutsideBox++;
 }
 assert.equal(changedPixelsOutsideBox,0,'changed pixels outside edit boxes');
 return{maxOriginDriftPt,changedPixels,changedPixelsOutsideBox,replacementGlyphs,replacementIndices};
}
export const compareSubstitutedNativePages=(before:Snapshot,after:Snapshot,edit:Edit)=>compareNativePages(before,after,edit,true);
const command=(name:string,args:string[])=>{const r=spawnSync(name,args,{encoding:'utf8'});assert.equal(r.status,0,`${name}: ${r.stdout}${r.stderr}`);return r.stdout;};
export async function auditCorpusSample(native:ReturnType<typeof openPdfium>,name:string,directory:string,edit:Edit,stage5Type1:Type1Options={},stage5Reflow=process.env.SHIORI_STAGE5_REFLOW!=='0',manifest?:AppliedReflowManifest,outcome?:ContentTextOutcome['mode']|ContentTextOutcome){
 const mode=typeof outcome==='string'?outcome:outcome?.mode;
 assert.notEqual(mode,'unsupported','unsupported samples cannot be audited as successes');
 const retypeset=mode==='retypeset'||(typeof outcome==='object'&&outcome.fidelity==='approximate');
 const beforePath=`${directory}/${name}.before.pdf`,afterPath=`${directory}/${name}.after.pdf`;
 const before=native.inspectPage(beforePath,0,true),after=native.inspectPage(afterPath,0,true);
 const useManifest=!retypeset&&stage5Reflow&&manifest;
 if(useManifest){const original=await PDFDocument.load(new Uint8Array(await readFile(beforePath))),source=inspectRunPage(original.getPage(0));assert(source.ok&&source.sourceHash===useManifest.sourceHash,'manifest source revision differs');}
 let checked,sourceOwnership:ReturnType<typeof retypesetSourceOwnership>|undefined;
 try{
  const reference=useManifest?await backdropReferencePdf(new Uint8Array(await readFile(beforePath)),useManifest):undefined;
  const original=retypeset?await PDFDocument.load(new Uint8Array(await readFile(beforePath))):undefined;
  sourceOwnership=original?retypesetSourceOwnership(original.getPage(0),before.glyphs,edit,stage5Type1):undefined;
  checked=retypeset?compareRetypesetNativePages(before,after,edit,typeof outcome==='object'?outcome.retypeset:undefined,sourceOwnership):useManifest?compareReflowNativePages(before,after,edit,useManifest,reference?native.inspectPage(reference,0,true):undefined):compareNativePages(before,after,edit,mode==='substituted');
 }
 catch(error){
  if(useManifest&&error instanceof Error&&error.message.includes('raster veto'))await saveReflowVetoArtifact({name,
   before:new Uint8Array(await readFile(beforePath)),after:new Uint8Array(await readFile(afterPath)),edit,manifest:useManifest,error});
  throw error;
 }
 const bytes=new Uint8Array(await readFile(afterPath)),doc=await PDFDocument.load(bytes),objects=new Map<string,string>();
 let untargetedStreamGlyphs:number|undefined;
 let formWalkEvidence:{formWalkSourceIssues:number;formWalkInheritedIssues:number}|undefined;
 if('ownedSourceGlyphs' in checked){
  const original=await PDFDocument.load(new Uint8Array(await readFile(beforePath)));
  assert(sourceOwnership,'missing retypeset source ownership');
  untargetedStreamGlyphs=assertRetypesetStreamIdentity(original.getPage(0),doc.getPage(0),sourceOwnership,stage5Type1,checked.pushedSourceGlyphs);
  const {formWalkSourceIssues,formWalkInheritedIssues}=compareRetypesetFormWalk(original.getPage(0),doc.getPage(0),stage5Type1);
  formWalkEvidence={formWalkSourceIssues,formWalkInheritedIssues};
  for(const [hash,ref]of retypesetFontObjects(original.getPage(0),doc.getPage(0),after.glyphs,stage5Type1))objects.set(hash,ref);
 }
 for(const[ref,value]of doc.context.enumerateIndirectObjects())if(value instanceof PDFDict && value.get(PDFName.of('Type'))===PDFName.of('FontDescriptor')){
  const raw=value.lookup(PDFName.of('FontFile2'))??value.lookup(PDFName.of('FontFile3'))??value.lookup(PDFName.of('FontFile'));
  if(!(raw instanceof PDFRawStream))continue;
  const data=raw.dict.has(PDFName.of('Filter'))?decodePDFRawStream(raw).decode():raw.getContents(),hash=createHash('sha256').update(data).digest('hex');
  for(const[fontRef,font]of doc.context.enumerateIndirectObjects())if(font instanceof PDFDict && font.get(PDFName.of('FontDescriptor'))?.toString()===ref.toString()){
   if(font.get(PDFName.of('Subtype'))===PDFName.of('CIDFontType0') || font.get(PDFName.of('Subtype'))===PDFName.of('CIDFontType2')){
    for(const[parentRef,parent]of doc.context.enumerateIndirectObjects())if(parent instanceof PDFDict && parent.get(PDFName.of('Subtype'))===PDFName.of('Type0') && parent.lookup(PDFName.of('DescendantFonts'))?.toString().includes(fontRef.toString()))objects.set(hash,parentRef.toString());
   }else objects.set(hash,fontRef.toString());
  }
 }
 const actual=after.glyphs.filter(g=>compact(g.text)),probes=new Map<string,ReturnType<typeof native.inspectPage>['glyphs']>();
 for(const index of checked.replacementIndices){const g=actual[index]!,hash=g.fontHash!;
  if(probes.has(hash))continue;const object=objects.get(hash);assert(object,'replacement native program not found in saved PDF');
  const probe=retypeset?await retypesetNotdefProbePdf(bytes,object):await notdefProbePdf(bytes,[object]);await writeFile(`${directory}/${name}.${hash.slice(0,8)}.notdef.pdf`,probe);
  const evidence=native.inspectPage(probe,0,true);assert(evidence.glyphs.every(p=>p.fontHash===hash),'native notdef probe font differs');probes.set(hash,evidence.glyphs);
 }
 const glyphEvidence=checked.replacementIndices.map(index=>{const g=actual[index]!,p=probes.get(g.fontHash!)!;
  const id=objects.get(g.fontHash!)!.split(' ').map(Number),font=doc.context.lookup(PDFRef.of(id[0]!,id[1]!),PDFDict),coverage=fontCoverageFromDict(font,stage5Type1),encoded=coverage.canEncode(g.text);
  if(mode==='substituted'&&!retypeset){
   assert.equal(font.lookup(PDFName.of('Subtype'),PDFName).decodeText(),'Type0','substitute must be Type0');
   assert.equal(font.lookup(PDFName.of('Encoding'),PDFName).decodeText(),'Identity-H','substitute must be horizontal');
   assert(font.lookup(PDFName.of('ToUnicode')) instanceof PDFRawStream,'substitute ToUnicode missing');
   assert(encoded.ok,'substitute glyph cannot be encoded from saved subset');
  }
  const code=encoded.ok?Array.from(encoded.bytes,b=>b.toString(16).padStart(2,'0')).join(''):'';
  return{unicode:g.text,replacement:true,glyphId:coverage.glyphIds.get(code),pathSegments:g.nativePath?.length??0,nativePath:g.nativePath??null,inkPixels:g.inkPixels??0,notdefProbes:p.map(x=>({scalar:x.text.codePointAt(0)!,path:x.nativePath??null}))};});
 assertNativeReplacementGlyphs(glyphEvidence);
 let nativeSourceProofs=0;
 for(let i=0;i<glyphEvidence.length;i++){
  const evidence=glyphEvidence[i]!,g=actual[checked.replacementIndices[i]!]!;
  if(evidence.glyphId!==undefined){assertReplacementGlyphs([evidence]);continue;}
  // Approximate output needs real native ink/outline distinct from forced
  // .notdef, already checked above; it may introduce new Type1 characters.
  if(retypeset)continue;
  // Type1 identities use glyph names, not GIDs. Reuse also requires an
  // independent native proof: same source font program, Unicode and full
  // outline as a real original glyph, plus the GID0 discriminator above.
  assert(before.glyphs.some(old=>old.text===g.text && old.fontHash===g.fontHash && JSON.stringify(old.nativePath)===JSON.stringify(g.nativePath)),'unverified replacement is not an existing native source glyph');
  nativeSourceProofs++;
 }
 const qpdf=await auditQpdfPair(beforePath,afterPath);
 const oldText=compact(command('pdftotext',['-layout',beforePath,'-'])),newText=compact(command('pdftotext',['-layout',afterPath,'-']));
 let poppler;
 if(retypeset){
  poppler=assertRetypesetPopplerText(oldText,newText,before.text,after.text);
 }else assert.equal(newText,useManifest?compact(after.text):expectedPopplerText(oldText,edit),'Poppler extracted text mismatch');
 const {replacementIndices:_,ownedSourceGlyphs:__,pushedSourceGlyphs:___,...evidence}={ownedSourceGlyphs:undefined,pushedSourceGlyphs:undefined,...checked};void _;void __;void ___;
 const result={name,...evidence,...(retypeset?{oracleTier:'retypeset',untargetedStreamGlyphs,...formWalkEvidence}:{}),stage5Reflow,nativeSourceProofs,nonNotdefGlyphs:glyphEvidence.length,...qpdf,...poppler,nativeText:after.text,popplerText:newText,passed:true};
 await writeFile(`${directory}/${name}.oracle.json`,JSON.stringify(result,null,2));return result;
}
