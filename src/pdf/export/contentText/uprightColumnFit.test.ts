import {expect,test} from 'bun:test';
import {PDFDocument} from 'pdf-lib';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {openPdfium} from '../../../../scripts/pdf-inplace/nativePdfium';
import {buildCorpusOverlays} from '../../../../scripts/pdf-corpus/overlays';
import {editMatrix} from '../../../../scripts/pdf-corpus/editMatrix';
import {compareRetypesetNativePages} from '../../../../scripts/pdf-corpus/retypesetOracle';
import {assertRetypesetStreamIdentity,retypesetSourceOwnership} from '../../../../scripts/pdf-corpus/retypesetStreamOracle';
import {assertRetypesetPopplerText} from '../../../../scripts/pdf-corpus/retypesetPoppler';
import {exportPdf} from '../exportPdf';
import {loadFont} from './uprightColumn.fixture.test';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {readVerticalSource} from './verticalSource';
import {contains,subtractRectangles} from './regionProof/geometry';

// Failure list before the spacing retry:
// - growth leaves a per-column clip or the declared Identity-V mask;
// - mask containment mistakes a rectangle union for its bounding box;
// - squeezing changes font size, the first cell, or any unselected text;
// - destination ink overlaps other text/paint or leaves the page;
// - output collides with itself or packs rows tighter than 0.8 em;
// - an explicit break or excessive growth silently becomes a single column;
// - refusal changes source bytes or resources.
async function corpusEdit(id:string,index:number,kind:string){
 const input=await PDFDocument.load(await readFile(`scripts/pdf-corpus/fixtures/vertical/${id}.pdf`)),doc=await PDFDocument.create(),[copy]=await doc.copyPages(input,[index]),page=doc.addPage(copy!);
 const before=await doc.save(),native=openPdfium('vendor/pdfium/linux-x64/lib/libpdfium.so');
 try{
  const snapshot=native.inspectPage(before,0,true),crop=page.getCropBox(),model={id:'p',sourceIndex:0,widthPt:crop.width,heightPt:crop.height,rotation:0 as const};
  const selection=buildCorpusOverlays(snapshot,model,{vertical:true}).find(o=>!o.originalText.includes('\n')&&/\p{Script=Han}/u.test(o.originalText))!;
  const edit={...selection,text:editMatrix(selection.originalText).find(e=>e.kind===kind)!.text};
  const result=await exportPdf(before,{pages:[model],overlays:[edit]},{mode:'flatten',stage5Type1:{sourceReuse:true},stage5Reflow:true,stage5Substitute:true,inPlaceFallback:{loadFont}});
  const after=await PDFDocument.load(result.bytes),outcome=result.contentTextOutcomes![0]!;
 return{before,bytes:result.bytes,snapshot,after:after.getPage(0),output:native.inspectPage(result.bytes,0,true),page,edit,outcome};
 }finally{native.close();}
}

for(const [id,index,kind]of [
 ['vert-browser-jp-tcy',0,'longer'],
 ['vert-browser-jp-tcy',1,'longer'],
 ['vert-identityv-jp-kumo',0,'longer'],
 ['vert-identityv-jp-tcy',0,'longer'],
 ['vert-typst-jp-rashomon',0,'overflow-unbreakable'],
]as const)test(`${id} page ${index}: ${kind} stays in its column with all other text stationary`,async()=>{
 const r=await corpusEdit(id,index,kind);
 expect(r.outcome).toMatchObject({mode:'retypeset',retypeset:{pushed:false,lineCount:1}});
 if(r.outcome.mode!=='retypeset')return;
 const ownership=retypesetSourceOwnership(r.page,r.snapshot.glyphs,r.edit,{sourceReuse:true});
 const audit=compareRetypesetNativePages(r.snapshot,r.output,r.edit,r.outcome.retypeset,ownership);
 expect(audit.maxOriginDriftPt).toBeLessThanOrEqual(.01);
 expect(audit.changedPixelsOutsideRetypesetMask).toBe(0);
 assertRetypesetStreamIdentity(r.page,r.after,ownership,{sourceReuse:true});
 const poppler=(input:Uint8Array)=>{const result=spawnSync('pdftotext',['-layout','-','-'],{input,encoding:'utf8'});expect(result.status).toBe(0);return result.stdout;};
 assertRetypesetPopplerText(poppler(r.before),poppler(r.bytes),r.snapshot.text,r.output.text);
 const before=r.snapshot.glyphs.filter(g=>r.edit.coverRects.some(b=>g.origin[0]>=b.x&&g.origin[0]<=b.x+b.w&&g.origin[1]>=b.y&&g.origin[1]<=b.y+b.h));
 const output=r.output.glyphs.filter(g=>Math.abs(g.origin[0]-before[0]!.origin[0])<3&&g.origin[1]<=before[0]!.origin[1]+.01&&g.origin[1]>=before.at(-1)!.origin[1]-2);
 expect(output[0]!.origin).toEqual(before[0]!.origin);
 expect(output.every(g=>g.fontSize===before[0]!.fontSize)).toBe(true);
 if(id.includes('identityv')){
  const content=inspectRunPage(r.after);if(!content.ok)throw Error(content.reason);
  const changed=readVerticalSource(r.after,tokenizeContentStream(content.bytes)).glyphs.filter(g=>g.glyph.pen!.x===420||g.glyph.pen!.x===268);
  expect(changed.some(g=>!r.edit.coverRects.some(b=>contains(b,g.box!)))).toBe(true);
  for(const g of changed){
   if(g.glyph.pen!.y>800||g.glyph.pen!.y<r.edit.coverRects.at(-1)!.y)continue;
   expect(subtractRectangles(g.box!,r.edit.coverRects)).toEqual([]);
  }
 }
},30_000);

for(const kind of ['holes','break','clip','paint']as const)test(`spacing retry preserves a precise ${kind} refusal and source revision`,async()=>{
 const {verticalFixture,verticalText}=await import('./vertical.fixture.test');
 const {applyContentTextEdits}=await import('./apply');
 const f=await verticalFixture({stream:code=>`${kind==='clip'?'q 200 120 20 110 re W n ':''}BT /V1 16 Tf 1 0 0 1 210 210 Tm ${code(verticalText)} Tj ET${kind==='clip'?' Q':''}${kind==='paint'?' 0 0 0 rg 202.05 80 .05 130 re f':''}`});
 const content=inspectRunPage(f.page);if(!content.ok)throw Error(content.reason);
 const source=readVerticalSource(f.page,tokenizeContentStream(content.bytes));
 const covers=source.glyphs.map(g=>{const b=g.box!;return{x:b.x-.1,y:b.y-.1,w:b.w+.2,h:b.h+.2};});
 const edit={...f.edit,text:kind==='clip'?verticalText.repeat(4):kind==='break'?verticalText+'\n日':verticalText+'日',coverRects:kind==='clip'?f.edit.coverRects:kind==='paint'?[{x:200,y:70,w:20,h:160}]:covers};
 const resources=f.page.node.Resources(),count=f.doc.context.enumerateIndirectObjects().length,mask=JSON.stringify(edit.coverRects);
 const result=await applyContentTextEdits(f.page,[edit],{loadFont});
 expect(result.outcomes[0]).toMatchObject({mode:'unsupported'});
 expect(result.outcomes[0]!.detail).toContain(kind==='clip'?'vertical-clip':kind==='paint'?'vertical-obstacle':'vertical-mask');
 expect(inspectRunPage(f.page)).toEqual(content);expect(f.page.node.Resources()).toBe(resources);
 expect(f.doc.context.enumerateIndirectObjects()).toHaveLength(count);expect(JSON.stringify(edit.coverRects)).toBe(mask);
});
