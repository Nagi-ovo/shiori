import {expect,test} from 'bun:test';
import {PDFDocument} from 'pdf-lib';
import {readFile} from 'node:fs/promises';
import {openPdfium} from '../../../../scripts/pdf-inplace/nativePdfium';
import {buildCorpusOverlays} from '../../../../scripts/pdf-corpus/overlays';
import {editMatrix} from '../../../../scripts/pdf-corpus/editMatrix';
import {compareRetypesetNativePages} from '../../../../scripts/pdf-corpus/retypesetOracle';
import {assertRetypesetStreamIdentity,retypesetSourceOwnership} from '../../../../scripts/pdf-corpus/retypesetStreamOracle';
import {exportPdf} from '../exportPdf';
import {loadFont} from './uprightColumn.fixture.test';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {readRetypesetSource} from './retypesetSource';
import {columnInk} from './uprightColumnInk';
import {retypesetScopes} from './retypesetScopes';
import {contains,subtractRectangles} from './regionProof/geometry';
import {readVerticalSource} from './verticalSource';

// Failure list before bounded size fitting:
// - overflow still escapes a source clip or the exact rectangle-union mask;
// - a fitted cell changes shape, scale differs between cells, or size falls below .85;
// - retries move untargeted text, enter a populated column, or overlap paint;
// - failed candidates change resources, source bytes, or the edit contract;
// - explicit breaks disappear to make a single-column candidate fit.
// Clip-flow failure list: a wide content clip blocks an empty next column;
// an accepted fit becomes a wrap; a populated next column becomes writable.
async function editCorpus(id:string,index:number,kind:string){
 const input=await PDFDocument.load(await readFile(`scripts/pdf-corpus/fixtures/vertical/${id}.pdf`)),doc=await PDFDocument.create(),[copy]=await doc.copyPages(input,[index]),page=doc.addPage(copy!);
 const before=await doc.save(),native=openPdfium('vendor/pdfium/linux-x64/lib/libpdfium.so');
 try{
  const snapshot=native.inspectPage(before,0,true),crop=page.getCropBox(),model={id:'p',sourceIndex:0,widthPt:crop.width,heightPt:crop.height,rotation:0 as const};
  const overlays=buildCorpusOverlays(snapshot,model,{vertical:true}),selection=overlays.find(o=>kind==='multi-line'?o.originalText.includes('\n'):!o.originalText.includes('\n')&&/\p{Script=Han}/u.test(o.originalText))!;
  const text=kind==='multi-line'?editMatrix(selection.originalText.split('\n')[0]!)[0]!.text+'\n'+selection.originalText.split('\n').slice(1).join('\n'):editMatrix(selection.originalText).find(e=>e.kind===kind)!.text;
  const edit={...selection,text},mask=JSON.stringify(edit.coverRects);
  const result=await exportPdf(before,{pages:[model],overlays:[edit]},{mode:'flatten',stage5Type1:{sourceReuse:true},stage5Reflow:true,stage5Substitute:true,inPlaceFallback:{loadFont}});
  expect(JSON.stringify(edit.coverRects)).toBe(mask);
  const after=await PDFDocument.load(result.bytes),outcome=result.contentTextOutcomes![0]!;
  return{before,bytes:result.bytes,snapshot,after:after.getPage(0),output:native.inspectPage(result.bytes,0,true),page,edit,outcome};
 }finally{native.close();}
}

for(const [id,index,kind]of [
 ['vert-browser-jp-kumo',0,'overflow'],
 ['vert-browser-jp-kumo',1,'overflow-2'],
 ['vert-browser-jp-tcy',0,'overflow'],
 ['vert-identityv-jp-kumo',0,'overflow'],
]as const)test(`${id} ${index} ${kind}: bounded fitting stays inside the source constraints`,async()=>{
 const r=await editCorpus(id,index,kind);
 expect(r.outcome).toMatchObject({mode:'retypeset',retypeset:{pushed:false,lineCount:1}});
 if(r.outcome.mode!=='retypeset')return;
 const ownership=retypesetSourceOwnership(r.page,r.snapshot.glyphs,r.edit,{sourceReuse:true});
 const audit=compareRetypesetNativePages(r.snapshot,r.output,r.edit,r.outcome.retypeset,ownership);
 expect(audit.maxOriginDriftPt).toBeLessThanOrEqual(.01);
 expect(audit.changedPixelsOutsideRetypesetMask).toBe(0);
 assertRetypesetStreamIdentity(r.page,r.after,ownership,{sourceReuse:true});
 const replacement=audit.replacementIndices.map(i=>r.output.glyphs.filter(g=>g.text.trim())[i]!);
 const size=r.snapshot.glyphs.find(g=>r.edit.coverRects.some(b=>g.origin[0]>=b.x&&g.origin[0]<=b.x+b.w&&g.origin[1]>=b.y&&g.origin[1]<=b.y+b.h))!.fontSize;
 expect(replacement.every(g=>g.fontSize>=size*.85-.001&&g.fontSize<size)).toBe(true);
 expect(Math.max(...replacement.map(g=>g.fontSize))-Math.min(...replacement.map(g=>g.fontSize))).toBeLessThan(.001);
 const original=inspectRunPage(r.page),content=inspectRunPage(r.after);if(!original.ok||!content.ok)throw Error('unreadable stream');
 const originalScopes=retypesetScopes(tokenizeContentStream(original.bytes)),clips=[...originalScopes.values()].flatMap(s=>s.clip?[s.clip]:[]);
 if(id.includes('identityv')){
  const source=readVerticalSource(r.after,tokenizeContentStream(content.bytes));
  for(const g of source.glyphs.filter(g=>g.state.fontSize<14)){
   expect(g.state.fontSize).toBeGreaterThanOrEqual(14*.85-1e-6);
   expect(subtractRectangles(g.box!,r.edit.coverRects)).toEqual([]);
  }
 }else{
  const ops=tokenizeContentStream(content.bytes),source=readRetypesetSource(r.after,ops,undefined,undefined,{flippedType3:true}),ink=columnInk(r.after,source.fonts,ops);
  const changed=source.glyphs.filter(g=>g.x<110);
  expect(changed.length).toBeGreaterThan(0);
  for(const g of changed){
   const b=ink(source.fonts.find(f=>f.resourceName===g.glyph.fontName)!,g.glyph.code,g.state,g.x,g.y).box;
   expect(clips.some(c=>contains(c,b))).toBe(true);
  }
 }
},30_000);

for(const id of ['vert-browser-jp-kumo','vert-browser-jp-tcy'])test(`${id} page 0 overflow-2: an empty next column inside the clip remains available`,async()=>{
 const r=await editCorpus(id,0,'overflow-2');
 expect(r.outcome).toMatchObject({mode:'retypeset',retypeset:{pushed:false,lineCount:2}});
 if(r.outcome.mode!=='retypeset')return;
 const ownership=retypesetSourceOwnership(r.page,r.snapshot.glyphs,r.edit,{sourceReuse:true});
 const audit=compareRetypesetNativePages(r.snapshot,r.output,r.edit,r.outcome.retypeset,ownership);
 expect(audit.maxOriginDriftPt).toBeLessThanOrEqual(.01);
 expect(audit.changedPixelsOutsideRetypesetMask).toBe(0);
 assertRetypesetStreamIdentity(r.page,r.after,ownership,{sourceReuse:true});
},30_000);

for(const [id,index]of [['vert-browser-jp-tcy',1],['vert-luatex-jp-tcy-2col',2]]as const)for(const kind of ['overflow','overflow-2'])test(`${id} page ${index} ${kind}: a populated next column remains refused`,async()=>{
 const r=await editCorpus(id,index,kind);
 expect(r.outcome).toMatchObject({mode:'unsupported'});
 expect(r.outcome.detail).toContain('flow: vertical-obstacle:');
 expect(inspectRunPage(r.after)).toEqual(inspectRunPage(r.page));
},30_000);

for(const [id,index,kind,reason]of [
 ['vert-identityv-jp-tcy',0,'overflow-2','vertical-mask'],
 ['vert-identityv-jp-kumo',0,'overflow-2','vertical-mask'],
]as const)test(`${id} ${kind}: unproved fit keeps its precise refusal`,async()=>{
 const r=await editCorpus(id,index,kind);
 expect(r.outcome).toMatchObject({mode:'unsupported'});expect(r.outcome.detail).toContain(reason);
 expect(inspectRunPage(r.after)).toEqual(inspectRunPage(r.page));
},30_000);

// The split overlay 案\nと names two consecutive cells of one column, not a
// column break: it lays out in place at full size, with no fit retry.
test('vert-identityv-jp-tcy multi-line: a one-column break stays in its column',async()=>{
 const r=await editCorpus('vert-identityv-jp-tcy',0,'multi-line');
 expect(r.outcome).toMatchObject({mode:'retypeset',retypeset:{pushed:false,lineCount:1,overflowed:false}});
 if(r.outcome.mode!=='retypeset')return;
 const ownership=retypesetSourceOwnership(r.page,r.snapshot.glyphs,r.edit,{sourceReuse:true});
 const audit=compareRetypesetNativePages(r.snapshot,r.output,r.edit,r.outcome.retypeset,ownership);
 expect(audit.maxOriginDriftPt).toBeLessThanOrEqual(.01);expect(audit.changedPixelsOutsideRetypesetMask).toBe(0);
 assertRetypesetStreamIdentity(r.page,r.after,ownership,{sourceReuse:true});
 const replacement=audit.replacementIndices.map(i=>r.output.glyphs.filter(g=>g.text.trim())[i]!);
 expect(replacement.map(g=>g.text).join('')).toBe('éと');expect(replacement.every(g=>Math.abs(g.fontSize-14)<.001)).toBe(true);
 const source=r.snapshot.glyphs.find(g=>g.text==='と'&&r.edit.coverRects.some(b=>g.origin[1]>=b.y&&g.origin[1]<=b.y+b.h))!;
 expect(replacement[1]!.origin[0]).toBeCloseTo(source.origin[0],2);expect(replacement[1]!.origin[1]).toBeCloseTo(source.origin[1],2);
},30_000);
