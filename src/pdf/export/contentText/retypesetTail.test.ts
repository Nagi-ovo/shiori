import {expect,test} from 'bun:test';
import {PDFDict,PDFDocument,PDFName} from 'pdf-lib';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fixture,overlay} from './fixtures.test-support';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {address,readRetypesetSource} from './retypesetSource';
import {planRetypeset,selectRetypeset} from './retypesetPlan';
import {writeRetypeset} from './retypesetWrite';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import {openPdfium} from '../../../../scripts/pdf-inplace/nativePdfium';
import {compareRetypesetNativePages} from '../../../../scripts/pdf-corpus/retypesetOracle';
import {assertRetypesetStreamIdentity,retypesetSourceOwnership} from '../../../../scripts/pdf-corpus/retypesetStreamOracle';

// Failure list recorded in STATUS.md before implementation. All measurements
// below use the real planner/writer and independently reopened saved glyphs.
const full='AAAA BBBB CCCC DDDD',short='EEEE',replacement=full+' ZZZZ';
const command='bun test src/pdf/export/contentText/retypesetTail.test.ts';
const outsiders='BT /F1 10 Tf 50 195 Td (HEADER) Tj ET BT /F1 10 Tf 50 30 Td (OTHER PARAGRAPH) Tj ET';
async function setup(options:{last?:string;tailPrefix?:string;first?:number;unknown?:boolean;text?:string;denyJoin?:boolean;extra?:string}={}){
 const rows=Array.from({length:8},(_,i)=>i===7?options.last??short:full);
 const first=options.first??0;
 const stream=`BT /F1 10 Tf 14 TL 50 170 Td ${rows.map((s,i)=>`${i?'T* ':''}${i===4?options.tailPrefix??'':''}(${s}) Tj`).join(' ')} ET ${outsiders} ${options.extra??''}`;
 const f=await fixture(stream),font=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict);
 font.set(PDFName.of('F2'),font.get(PDFName.of('F1'))!);
 const ops=tokenizeContentStream(f.source),source=readRetypesetSource(f.page,ops);
 expect(source.walk.ok).toBe(true);
 if(options.unknown)source.glyphs.find(g=>g.y===72)!.text=undefined;
 if(options.denyJoin){
  const font=source.fonts[0]!,encode=font.canEncode!;
  font.canEncode=(s,o)=>s===' '?{ok:false,reason:'unproved join',firstMissing:s,offset:0}:encode(s,o);
 }
 const edit=overlay({originalText:full,text:options.text??replacement,coverRects:[{x:49,y:169-first*14,w:116,h:12}]}),selected=selectRetypeset(source.glyphs,edit);
 const plan=planRetypeset(source.glyphs,ops,[{overlay:edit,selected,reason:'overflow'}]);
 expect(plan.group.lines).toHaveLength(8);
 const before=await f.doc.save();
 const write=()=>writeRetypeset(f.page,f.source,ops,source,[plan],{});
 return{...f,ops,source,edit,plan,before,rows,write};
}
function savedGlyphs(f:Awaited<ReturnType<typeof setup>>){
 const s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);
 return readRetypesetSource(f.page,tokenizeContentStream(s.bytes)).glyphs;
}
const positions=(gs:ReturnType<typeof savedGlyphs>)=>gs.map(g=>[g.text,g.glyph.fontName,g.glyph.code,g.x,g.y]);

test('tail slack keeps source size before painted coverage clears a margin-note flag',async()=>{
 const blocker='0 60 300 1 re f ';
 const clean=await setup({extra:blocker}),noted=await setup({extra:blocker+'BT /F1 8 Tf 0 1 -1 0 292 30 Tm (SIDE NOTE) Tj ET'});
 const [baseline]=await clean.write(),[manifest]=await noted.write(),now=savedGlyphs(noted);
 expect(manifest).toMatchObject({lineCount:8,overflowed:false,pushed:false,pushedDeltaPt:0,overflowInkOverlap:false,unchangedLineDriftPt:0});
 expect(manifest!.fitStrategy).toBeUndefined();
 expect(manifest).toEqual(baseline);
 expect(positions(now.filter(g=>g.state.fontSize===10))).toEqual(positions(savedGlyphs(clean)));
 expect(positions(now.filter(g=>g.state.fontSize===8))).toEqual(positions(noted.source.glyphs.filter(g=>g.state.fontSize===8)));
 const dir='test-artifacts/r32-p2c-c1/tail-before-painted';await mkdir(dir,{recursive:true});
 await writeFile(`${dir}/before.pdf`,noted.before);await writeFile(`${dir}/after.pdf`,await noted.doc.save());
 await writeFile(`${dir}/report.json`,JSON.stringify({command,manifest,paragraphMatchesClean:true,marginNoteUnmoved:true},null,2));
});

test('first-line wrap uses eight-line tail slack without added height or moving another paragraph',async()=>{
 const f=await setup(),[manifest]=await f.write(),now=savedGlyphs(f);
 expect(manifest).toMatchObject({lineCount:8,overflowed:false,pushed:false,pushedDeltaPt:0,overflowInkOverlap:false,unchangedLineDriftPt:0});
 expect(positions(now.filter(g=>g.y===195||g.y===30))).toEqual(positions(f.source.glyphs.filter(g=>g.y===195||g.y===30)));
 expect(now.filter(g=>g.y<=170&&g.y>=72).map(g=>g.text).join('').replace(/\s/gu,''))
  .toBe([replacement,...f.rows.slice(1)].join('').replace(/\s/gu,''));
 expect(now.some(g=>g.text==='Z'&&g.y===156)).toBe(true);
 expect(now.filter(g=>g.text==='E'&&g.y===72)).toHaveLength(4);
 const after=await f.doc.save(),native=openPdfium(resolve('vendor/pdfium/linux-x64/lib/libpdfium.so'));
 try{
  const a=native.inspectPage(f.before,0,true),b=native.inspectPage(after,0,true);
  const original=await PDFDocument.load(f.before),owned=retypesetSourceOwnership(original.getPage(0),a.glyphs,f.edit);
  expect(owned).toHaveLength(f.rows.join('').length);
  expect(owned.some(g=>g.origin[1]===72)).toBe(true);
  expect(owned.every(g=>g.origin[1]!<=170&&g.origin[1]!>=72)).toBe(true);
  const checked=compareRetypesetNativePages(a,b,f.edit,manifest,owned);
  expect(checked).toMatchObject({maxOriginDriftPt:0,changedPixelsOutsideRetypesetMask:0});
  expect(assertRetypesetStreamIdentity(original.getPage(0),f.page,owned)).toBe(21);
  const dir='test-artifacts/r32-p2c/full-slack';await mkdir(dir,{recursive:true});
  await writeFile(`${dir}/tail.before.pdf`,f.before);await writeFile(`${dir}/tail.after.pdf`,after);
  await writeFile(`${dir}/tail.json`,JSON.stringify({command,manifest,owned,driftThresholdPt:.01,maxOtherParagraphDriftPt:checked.maxOriginDriftPt,changedPixelsOutsideRetypesetMask:checked.changedPixelsOutsideRetypesetMask},null,2));
  await writeFile(`${dir}/README.md`,`Regenerate the saved PDF/native audit: ${command}\n`);
 }finally{native.close();}
});

test('ownership explicitly includes the extended tail and excludes the unchanged prefix and other paragraphs',async()=>{
 const f=await setup({first:2}),[manifest]=await f.write();
 expect(manifest).toMatchObject({lineCount:8,overflowed:false,pushed:false});
 const native=openPdfium(resolve('vendor/pdfium/linux-x64/lib/libpdfium.so'));
 try{
  const original=await PDFDocument.load(f.before),a=native.inspectPage(f.before,0,true),b=native.inspectPage(await f.doc.save(),0,true);
  const owned=retypesetSourceOwnership(original.getPage(0),a.glyphs,f.edit);
  expect(owned).toHaveLength(f.rows.slice(2).join('').length);
  expect(owned.every(g=>g.origin[1]!<=142&&g.origin[1]!>=72)).toBe(true);
  expect(compareRetypesetNativePages(a,b,f.edit,manifest,owned).maxOriginDriftPt).toBe(0);
  expect(()=>assertRetypesetStreamIdentity(original.getPage(0),f.page,owned.filter(g=>g.origin[1]!==72))).toThrow('codes/font/position');
  expect(assertRetypesetStreamIdentity(original.getPage(0),f.page,owned)).toBe(59);
 }finally{native.close();}
});

for(const tailPrefix of ['/F2 10 Tf ','1 0 0 rg ','q Q '])test(`mixed font, paint or scope tail keeps changed-line ownership (${tailPrefix.trim()})`,async()=>{
 const f=await setup({tailPrefix}),[manifest]=await f.write();
 expect(manifest).toMatchObject({lineCount:9,overflowed:true});
 expect(new TextDecoder().decode((inspectRunPage(f.page) as {bytes:Uint8Array}).bytes)).toContain(`(${short}) Tj`);
 expect(f.plan.tail.every(g=>g.y===170)).toBe(true);
});

test('a tail without readable Unicode keeps the changed-line plan',async()=>{
 const f=await setup({unknown:true}),[manifest]=await f.write();
 expect(manifest).toMatchObject({lineCount:9,overflowed:true});
 expect(f.plan.tail.every(g=>g.y===170)).toBe(true);
});

test('an unencodable synthetic join does not authorize rewriting tail lines',async()=>{
 const f=await setup({denyJoin:true,text:'AAAAAAAA BBBB CCCC DDDD'}),[manifest]=await f.write();
 expect(manifest).toMatchObject({lineCount:9,overflowed:true});
 expect(new TextDecoder().decode((inspectRunPage(f.page) as {bytes:Uint8Array}).bytes)).toContain(`(${short}) Tj`);
});

test('a non-wrapping change leaves the original tail stationary',async()=>{
 const f=await setup({text:'ZZZZ BBBB CCCC DDDD'}),[manifest]=await f.write();
 expect(manifest).toMatchObject({lineCount:8,overflowed:false,pushed:false});
 const stream=inspectRunPage(f.page);if(!stream.ok)throw Error(stream.reason);
 expect(new TextDecoder().decode(stream.bytes).match(/\(AAAA BBBB CCCC DDDD\) Tj/gu)).toHaveLength(6);
 expect(new TextDecoder().decode(stream.bytes)).toContain(`(${short}) Tj`);
});

test('no reduction in added height keeps the original tail operators and push',async()=>{
 const f=await setup({last:full}),[manifest]=await f.write();
 expect(manifest).toMatchObject({lineCount:9,overflowed:true,pushed:true,pushedDeltaPt:14});
 const stream=inspectRunPage(f.page);expect(stream.ok).toBe(true);
 if(!stream.ok)throw Error(stream.reason);
 expect(new TextDecoder().decode(stream.bytes).match(/\(AAAA BBBB CCCC DDDD\) Tj/gu)).toHaveLength(7);
 expect(f.plan.tail.map(g=>address(g.glyph))).toEqual(f.source.glyphs.filter(g=>g.y===170).map(g=>address(g.glyph)));
});

test('a selection spanning two paragraphs cannot close their observed pitch gap',async()=>{
 const rows=Array.from({length:8},(_,i)=>i===7?short:full),ys=rows.map((_,i)=>170-i*14-(i>=4?28:0));
 const f=await fixture(`BT /F1 10 Tf 14 TL 50 170 Td ${rows.map((s,i)=>`${i?'T* ':''}${i===4?'0 -28 Td ':''}(${s}) Tj`).join(' ')} ET`);
 const ops=tokenizeContentStream(f.source),source=readRetypesetSource(f.page,ops);
 const edit=overlay({originalText:rows.join('\n'),text:[replacement,...rows.slice(1)].join('\n'),coverRects:ys.map(y=>({x:49,y:y-1,w:116,h:12}))});
 const plan=planRetypeset(source.glyphs,ops,[{overlay:edit,selected:selectRetypeset(source.glyphs,edit),reason:'overflow'}]);
 expect(plan.group.lines).toHaveLength(8);
 const [manifest]=await writeRetypeset(f.page,f.source,ops,source,[plan],{}),saved=inspectRunPage(f.page);
 expect(manifest).toMatchObject({lineCount:9,overflowed:true});
 if(!saved.ok)throw Error(saved.reason);
 expect(new TextDecoder().decode(saved.bytes)).toContain(`(${short}) Tj`);
 const now=readRetypesetSource(f.page,tokenizeContentStream(saved.bytes)).glyphs;
 expect(positions(now.filter(g=>g.y<=86))).toEqual(positions(source.glyphs.filter(g=>g.y<=86)));
});
