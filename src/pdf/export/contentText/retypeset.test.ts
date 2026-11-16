import {expect,test} from 'bun:test';
import {PDFDict,PDFDocument,PDFName} from 'pdf-lib';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {openPdfium} from '../../../../scripts/pdf-inplace/nativePdfium';
import {exportPdf} from '../exportPdf';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {applyContentTextEdits} from './apply';
import {fixture,overlay,model} from './fixtures.test-support';

// Failure list, before implementation: overflow must remove actual source
// codes, never paint a cover; stroke/colour/clip/marked scope must survive;
// missing Unicode must use user text; prefix and unrelated TJ glyphs must
// retain codes/fonts/positions; same-paragraph edits must compose; scans,
// forms, empty and malformed streams must fail without drawing anything.
export const loadFont=(name:string)=>readFile(name.startsWith('Noto')?`src/assets/fonts/${name}`:`node_modules/@docx-editor.dev/fonts/assets/${name}`);
const text=async(bytes:Uint8Array)=>{const d=await PDFDocument.load(bytes),s=inspectRunPage(d.getPage(0));if(!s.ok)throw Error(s.reason);return new TextDecoder().decode(s.bytes);};

test('overflow retypesets source text without a cover; native extraction, ink and neighbours survive',async()=>{
 const f=await fixture('0.85 g 40 50 150 80 re f 0 g BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET BT /F1 10 Tf 200 150 Td (KEEP) Tj ET');
 const before=await f.doc.save(),edit=overlay({text:'new words that wrap'});
 const result=await exportPdf(before,model([edit]),{mode:'flatten',inPlaceFallback:{loadFont}});
 expect(result.contentTextOutcomes?.[0]).toMatchObject({mode:'retypeset',fidelity:'approximate',retypeset:{reason:'overflow',pushed:false,overflowed:true,substituteFont:null}});
 const stream=await text(result.bytes);
 expect(stream).not.toContain('(ABCDE)');
 expect(tokenizeContentStream(new TextEncoder().encode(stream)).filter(o=>o.operator==='re')).toHaveLength(1);
 const native=openPdfium(resolve('vendor/pdfium/linux-x64/lib/libpdfium.so'));
 try{
  const a=native.inspectPage(before,0,true),b=native.inspectPage(result.bytes,0,true);
  expect(b.text.replace(/\s/g,'')).toContain('newwordsthatwrap');expect(b.text).not.toContain('ABCDE');
  for(const word of ['new','words','that','wrap'])expect(b.text).toContain(word);
  expect(b.glyphs.filter(g=>g.origin[0]>=200).map(g=>[g.text,g.fontHash,g.origin])).toEqual(a.glyphs.filter(g=>g.origin[0]>=200).map(g=>[g.text,g.fontHash,g.origin]));
  expect(b.glyphs.filter(g=>g.text.trim()).every(g=>g.nativePath?.length&&g.inkPixels!>0)).toBe(true);
  const boxes=[...a.glyphs.filter(g=>g.origin[0]<200),...b.glyphs.filter(g=>g.origin[0]<200)].map(g=>g.box);
  let outside=0,changed=0;
  for(let i=0;i<a.pixels!.length;i+=4)if(a.pixels!.subarray(i,i+4).some((v,j)=>v!==b.pixels![i+j])){
   changed++;const x=(i/4)%(a.width*2)/2,y=a.height-Math.floor(i/4/(a.width*2))/2;
   if(!boxes.some(([l,bot,r,t])=>x>=l-1&&x<=r+1&&y>=bot-1&&y<=t+1))outside++;
  }
  expect(changed).toBeGreaterThan(0);expect(outside).toBe(0);
  const dir='test-artifacts/retypeset-m1';await mkdir(dir,{recursive:true});
  await writeFile(`${dir}/before.pdf`,before);await writeFile(`${dir}/after.pdf`,result.bytes);
  await writeFile(`${dir}/report.json`,JSON.stringify({command:'bun test src/pdf/export/contentText/retypeset.test.ts',outcome:result.contentTextOutcomes,changedPixels:changed,outsideMaskPixels:outside,nativeText:b.text},null,2));
 }finally{native.close();}
});

for(const tr of [1,2])test(`render mode ${tr} retypesets inside original paint and clip`,async()=>{
 const f=await fixture(`q 0 0 250 180 re W n 0.2 0.3 0.4 rg 0.9 0.1 0.2 RG 0.7 w BT /F1 10 Tf ${tr} Tr 50 100 Td (ABCDE) Tj ET Q`);
 const r=await applyContentTextEdits(f.page,[overlay({text:'long new words'})],{loadFont});
 expect(r.outcomes[0]).toMatchObject({mode:'retypeset',fidelity:'approximate'});
 const s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);const stream=new TextDecoder().decode(s.bytes);
 expect(stream).toContain(`${tr} Tr`);expect(stream).toContain('0.9 0.1 0.2 RG 0.7 w');expect(stream).not.toContain('(ABCDE)');
 expect(tokenizeContentStream(s.bytes).filter(o=>o.operator==='re')).toHaveLength(1);
});

test('missing ToUnicode does not block user Unicode in an embedded subset',async()=>{
 const f=await fixture(),font=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict);
 font.delete(PDFName.of('ToUnicode'));
 const r=await applyContentTextEdits(f.page,[overlay({text:'新的文字'})],{loadFont});
 expect(r.outcomes[0]).toMatchObject({mode:'retypeset',fidelity:'approximate'});
 const native=openPdfium(resolve('vendor/pdfium/linux-x64/lib/libpdfium.so'));
 try{expect(native.inspectPage(await f.doc.save()).text.replace(/\s/g,'')).toContain('新的文字');}finally{native.close();}
});

for(const group of ['/Artifact BMC','/OC /Hidden BDC'])test(`retypeset stays within ${group}`,async()=>{
 const f=await fixture(`${group} BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET EMC`);
 const r=await applyContentTextEdits(f.page,[overlay({text:'long new words'})],{loadFont});
 expect(r.outcomes[0]?.mode).toBe('retypeset');
 const s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);const stream=new TextDecoder().decode(s.bytes);
 const shown=tokenizeContentStream(s.bytes).filter(o=>o.operator==='Tj');expect(shown.length).toBeGreaterThan(0);expect(shown.every(o=>o.start>stream.indexOf(group)&&o.end<stream.lastIndexOf('EMC'))).toBe(true);
 expect(stream).not.toContain('(ABCDE)');
});

test('no text layer leaves page untouched and unsupported',async()=>{
 const f=await fixture('0.5 g 0 0 100 100 re f'),before=inspectRunPage(f.page);
 const r=await applyContentTextEdits(f.page,[overlay()],{loadFont});
 expect(r.outcomes[0]).toMatchObject({mode:'unsupported',reason:'unsupported-no-text-layer'});expect(inspectRunPage(f.page)).toEqual(before);
});

test('partial TJ removal keeps other glyph codes, font and positions',async()=>{
 const f=await fixture('BT /F1 10 Tf 50 100 Td [(AB) -120 (CDE)] TJ [-5000] TJ (Z) Tj ET');
 const {readRetypesetSource}=await import('./retypesetSource');
 const read=()=>{const s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);return readRetypesetSource(f.page,tokenizeContentStream(s.bytes));};
 const before=read().glyphs.find(g=>g.text==='Z')!;
 const r=await applyContentTextEdits(f.page,[overlay({text:'a much longer phrase',coverRects:[{x:49,y:98,w:33.2,h:13}]})],{loadFont});
 expect(r.outcomes[0]?.mode).toBe('retypeset');
 expect(read().glyphs.find(g=>g.text==='Z')!.glyph).toMatchObject({fontName:before.glyph.fontName,code:before.glyph.code,quad:before.glyph.quad});
});

test('two edits share a paragraph layout, retaining the earlier line and original unedited bytes',async()=>{
 const f=await fixture('BT /F1 10 Tf 14 TL 50 150 Td (ABCDE) Tj 0 -14 Td (ABCDE) Tj 0 -14 Td (ABCDE) Tj ET');
 const r=await applyContentTextEdits(f.page,[overlay({id:'one',originalText:'A',text:'new words',coverRects:[{x:49.9,y:134,w:6.2,h:12}]}),overlay({id:'two',originalText:'C',text:'more words',coverRects:[{x:61.9,y:120,w:6.2,h:12}]})],{stage5Reflow:false,loadFont});
 expect(r.outcomes.map(o=>o.mode)).toEqual(['retypeset','retypeset']);
 expect(r.outcomes[0]!.retypeset).toEqual(r.outcomes[1]!.retypeset);
 const s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);
 expect(new TextDecoder().decode(s.bytes)).toContain('(ABCDE) Tj');
 const {readRetypesetSource}=await import('./retypesetSource'),read=readRetypesetSource(f.page,tokenizeContentStream(s.bytes));
 expect(read.glyphs.filter(g=>g.y===150).map(g=>[g.text,g.glyph.fontName,g.glyph.code,g.x])).toEqual(Array.from('ABCDE',(c,i)=>[c,'F1',c.charCodeAt(0),50+i*6]));
 expect(read.glyphs.filter(g=>g.text==='B').every(g=>g.glyph.fontName==='F1'&&g.glyph.code===66)).toBe(true);
});

test('invisible OCR over an image stays unsupported; text forms retypeset',async()=>{
 for(const form of [false,true]){
  const f=await fixture(form?'/Scan Do':'q 300 0 0 200 0 0 cm /Scan Do Q BT /F1 10 Tf 3 Tr 50 100 Td (ABCDE) Tj ET');
  const stream=f.doc.context.stream(new TextEncoder().encode(form?'BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET':''),form?{Type:'XObject',Subtype:'Form',BBox:[0,0,300,200],Resources:f.page.node.Resources()!}:{Type:'XObject',Subtype:'Image',Width:1,Height:1,ColorSpace:'DeviceGray',BitsPerComponent:8});
  f.page.node.Resources()!.set(PDFName.of('XObject'),f.doc.context.obj({Scan:f.doc.context.register(stream)}));
  const before=inspectRunPage(f.page),r=await applyContentTextEdits(f.page,[overlay()],{loadFont});
  if(form)expect(r.outcomes[0]).toMatchObject({mode:'retypeset',fidelity:'approximate'});
  else {expect(r.outcomes[0]).toMatchObject({mode:'unsupported',reason:'unsupported-image-text'});expect(inspectRunPage(f.page)).toEqual(before);}
 }
});

test('a vector-only Form is no text layer, while an unrelated image does not block invisible text',async()=>{
 for(const form of [true,false]){
  const f=await fixture(form?'/Shape Do':'/Shape Do BT /F1 10 Tf 3 Tr 50 100 Td (ABCDE) Tj ET');
  const stream=f.doc.context.stream(new TextEncoder().encode(form?'0 0 100 100 re f':''),form?{Type:'XObject',Subtype:'Form',BBox:[0,0,100,100]}:{Type:'XObject',Subtype:'Image',Width:1,Height:1,ColorSpace:'DeviceGray',BitsPerComponent:8});
  f.page.node.Resources()!.set(PDFName.of('XObject'),f.doc.context.obj({Shape:f.doc.context.register(stream)}));
  const r=await applyContentTextEdits(f.page,[overlay({text:'long new words'})],{loadFont});
  if(form)expect(r.outcomes[0]).toMatchObject({mode:'unsupported',reason:'unsupported-no-text-layer'});
  else expect(r.outcomes[0]).toMatchObject({mode:'retypeset',fidelity:'approximate'});
 }
});

test('OCR over an image wrapped in a Form remains unsupported-image-text',async()=>{
 const f=await fixture('/Scan Do BT /F1 10 Tf 3 Tr 50 100 Td (ABCDE) Tj ET');
 const image=f.doc.context.register(f.doc.context.stream(Uint8Array.of(128),{Type:'XObject',Subtype:'Image',Width:1,Height:1,ColorSpace:'DeviceGray',BitsPerComponent:8}));
 const form=f.doc.context.register(f.doc.context.stream(new TextEncoder().encode('300 0 0 200 0 0 cm /Image Do'),{Type:'XObject',Subtype:'Form',BBox:[0,0,300,200],Resources:{XObject:{Image:image}}}));
 f.page.node.Resources()!.set(PDFName.of('XObject'),f.doc.context.obj({Scan:form}));
 const before=inspectRunPage(f.page),r=await applyContentTextEdits(f.page,[overlay()],{loadFont});
 expect(r.outcomes[0]).toMatchObject({mode:'unsupported',reason:'unsupported-image-text'});expect(inspectRunPage(f.page)).toEqual(before);
});

test('unparseable source is unsupported-unwritable and untouched',async()=>{
 const f=await fixture('BT /F1 10 Tf 50 100 Td (unterminated'),before=inspectRunPage(f.page);
 const r=await applyContentTextEdits(f.page,[overlay()],{loadFont});
 expect(r.outcomes[0]).toMatchObject({mode:'unsupported',reason:'unsupported-unwritable'});expect(inspectRunPage(f.page)).toEqual(before);
});

test('editing part of a multi-Unicode source glyph preserves the remaining letters',async()=>{
 const f=await fixture('BT /F1 10 Tf 50 100 Td (A) Tj ET'),font=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict);
 font.set(PDFName.of('ToUnicode'),f.doc.context.register(f.doc.context.stream(new TextEncoder().encode('1 beginbfchar <41> <006600660069> endbfchar'))));
 const r=await applyContentTextEdits(f.page,[overlay({originalText:'ff',text:'new',coverRects:[{x:49,y:98,w:8,h:13}]})],{loadFont});
 expect(r.outcomes[0]?.mode).toBe('retypeset');
 const native=openPdfium(resolve('vendor/pdfium/linux-x64/lib/libpdfium.so'));
 try{expect(native.inspectPage(await f.doc.save()).text.replace(/\s/g,'')).toBe('newi');}finally{native.close();}
});

test('a paragraph selection only relays out from its first edited line',async()=>{
 const f=await fixture('BT /F1 10 Tf 14 TL 50 150 Td (ABCDE) Tj 0 -14 Td (ABCDE) Tj ET');
 const r=await applyContentTextEdits(f.page,[overlay({originalText:'ABCDE\nABCDE',text:'ABCDE\nlong new words',coverRects:[{x:49,y:148,w:32,h:13},{x:49,y:134,w:32,h:13}]})],{stage5Reflow:false,loadFont});
 expect(r.outcomes[0]?.mode).toBe('retypeset');
 const s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);
 expect(new TextDecoder().decode(s.bytes)).toContain('(ABCDE) Tj 0 -14 Td');
});

test('measurable rotated text retains its original matrix and size',async()=>{
 const f=await fixture('BT /F1 10 Tf 0.8 0.6 -0.6 0.8 50 100 Tm (ABCDE) Tj ET');
 const r=await applyContentTextEdits(f.page,[overlay({text:'new rotated words',coverRects:[{x:40,y:95,w:50,h:45}]})],{loadFont});
 expect(r.outcomes[0]).toMatchObject({mode:'retypeset',retypeset:{reason:'unsupported-matrix'}});
 const s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);
 const matrices=tokenizeContentStream(s.bytes).filter(o=>o.operator==='Tm');
 expect(matrices.every(o=>o.operands.slice(0,4).map(n=>n.kind==='number'?n.value:NaN).join(',')==='0.8,0.6,-0.6,0.8')).toBe(true);
 const native=openPdfium(resolve('vendor/pdfium/linux-x64/lib/libpdfium.so'));
 try{const result=native.inspectPage(await f.doc.save(),0,true);expect(result.text.replace(/\s/g,'')).toBe('newrotatedwords');expect(result.glyphs.every(g=>Math.abs(g.fontSize-10)<.01)).toBe(true);}finally{native.close();}
});

for(const show of ["(ABCDE) '",'0 0 (ABCDE) "'])test(`quote show ${show} restores both text matrices`,async()=>{
 const f=await fixture(`BT /F1 10 Tf 14 TL 50 114 Td ${show} 0 -40 Td (KEEP) Tj ET`);
 const r=await applyContentTextEdits(f.page,[overlay({text:'long new words'})],{loadFont});
 expect(r.outcomes[0]?.mode).toBe('retypeset');
 const native=openPdfium(resolve('vendor/pdfium/linux-x64/lib/libpdfium.so'));
 try{const result=native.inspectPage(await f.doc.save());expect(result.text.replace(/\s/g,'')).toBe('longnewwordsKEEP');expect(result.glyphs.find(g=>g.text==='K')?.origin).toEqual([50,60]);}finally{native.close();}
});

for(const mode of ['flatten','annotations']as const)test(`no-text export draws nothing for the unsupported edit (${mode})`,async()=>{
 const f=await fixture('0.2 g 40 80 80 40 re f'),before=await f.doc.save();
 const result=await exportPdf(before,model([overlay()]),{mode});
 expect(result.contentTextOutcomes?.[0]).toMatchObject({mode:'unsupported',reason:'unsupported-no-text-layer'});
 const saved=await text(result.bytes);
 expect(tokenizeContentStream(new TextEncoder().encode(saved)).filter(o=>o.operator==='re')).toHaveLength(1);
 expect(saved).toContain('0.2 g');expect(saved).not.toContain('1 1 1 rg');
});

test('original-text export loads its subset without requiring the new-text overlay fonts',async()=>{
 const f=await fixture('BT /F1 10 Tf 1 Tr 50 100 Td (ABCDE) Tj ET');
 const result=await exportPdf(await f.doc.save(),model([overlay({text:'新的文字'})]),{mode:'flatten',requireUnicodeFont:true,inPlaceFallback:{loadFont}});
 expect(result.contentTextOutcomes?.[0]).toMatchObject({mode:'retypeset',fidelity:'approximate',retypeset:{substituteFont:'NotoSansSC-Regular.otf'}});
});

test('an exact sibling joins the approximate paragraph instead of retaining an invalid exact label',async()=>{
 const f=await fixture('BT /F1 10 Tf 50 100 Td [(A) -100 (BCDE)] TJ ET');
 const edits=[overlay({id:'one',originalText:'B',text:'X',coverRects:[{x:56.9,y:98,w:6.2,h:13}]}),overlay({id:'two',originalText:'D',text:'new words',coverRects:[{x:68.9,y:98,w:6.2,h:13}]})];
 const r=await applyContentTextEdits(f.page,edits,{stage5Reflow:false,loadFont});
 expect(r.outcomes.map(o=>[o.mode,o.fidelity])).toEqual([['retypeset','approximate'],['retypeset','approximate']]);
 expect(r.outcomes[0]?.retypeset?.paragraphBox).toEqual(r.outcomes[1]?.retypeset?.paragraphBox);
 const native=openPdfium(resolve('vendor/pdfium/linux-x64/lib/libpdfium.so'));
 try{expect(native.inspectPage(await f.doc.save()).text.replace(/\s/g,'')).toBe('AXCnewwordsE');}finally{native.close();}
});
