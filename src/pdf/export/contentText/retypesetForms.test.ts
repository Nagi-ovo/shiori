import {expect,test} from 'bun:test';
import {PDFDict,PDFName,PDFRawStream,decodePDFRawStream,type PDFPage} from 'pdf-lib';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {openPdfium} from '../../../../scripts/pdf-inplace/nativePdfium';
import {auditCorpusSample} from '../../../../scripts/pdf-corpus/oracle';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {applyContentTextEdits} from './apply';
import {fixture,overlay} from './fixtures.test-support';

// Failure list (before code): selecting transformed form text; longer text
// must remove source shows, extract and keep paint/clip/marked scopes without
// covers; page glyphs and unedited form glyphs keep identity. Shared pages,
// repeated Do and nested forms must isolate ONE occurrence. Inherited Tr must
// keep OCR invisible; image/vector forms remain no-text. Malformed, cyclic,
// singular, unmeasurable and concurrently changed sources must fail closed.
const loadFont=(name:string)=>readFile(`node_modules/@docx-editor.dev/fonts/assets/${name}`);
const source='q 0 0 300 200 re W n 0.2 0.3 0.4 rg /Artifact BMC BT /F1 10 Tf 1 Tr 50 100 Td (ABCDE) Tj ET EMC Q BT /F1 10 Tf 200 150 Td (KEEP) Tj ET';
async function formFixture(pageStream='/Fm Do',body=source){
 const f=await fixture(pageStream),resources=f.page.node.Resources()!.clone();
 const raw=f.doc.context.stream(new TextEncoder().encode(body),{Type:'XObject',Subtype:'Form',BBox:[0,0,300,200],Resources:resources});
 const ref=f.doc.context.register(raw);
 f.page.node.Resources()!.set(PDFName.of('XObject'),f.doc.context.obj({Fm:ref}));
 return {...f,raw,ref};
}
function usedForm(page:PDFPage){
 const s=inspectRunPage(page);if(!s.ok)throw Error(s.reason);
 const op=tokenizeContentStream(s.bytes).find(o=>o.operator==='Do')!,name=op.operands[0]!;if(name.kind!=='name')throw Error('missing form name');
 const objects=page.node.Resources()!.lookup(PDFName.of('XObject'),PDFDict);
 return {ref:objects.get(PDFName.of(name.value)),raw:objects.lookup(PDFName.of(name.value),PDFRawStream)};
}
const decoded=(raw:PDFRawStream)=>new TextDecoder().decode(raw.dict.has(PDFName.of('Filter'))?decodePDFRawStream(raw).decode():raw.getContents());
test('longer form text rewrites its stream with native ink, extraction and neighbour identity',async()=>{
 const f=await formFixture('/Fm Do BT /F1 10 Tf 20 180 Td (PAGE) Tj ET'),before=await f.doc.save(),edit=overlay({text:'long new words'});
 const r=await applyContentTextEdits(f.page,[edit],{loadFont});
 expect(r.outcomes[0]).toMatchObject({mode:'retypeset',fidelity:'approximate'});
 const copy=usedForm(f.page);expect(copy.ref).not.toEqual(f.ref);expect(decoded(f.raw)).toBe(source);
 const stream=decoded(copy.raw);expect(stream).not.toContain('(ABCDE)');expect(stream).toContain('0.2 0.3 0.4 rg /Artifact BMC');
 expect(tokenizeContentStream(new TextEncoder().encode(stream)).filter(o=>o.operator==='re')).toHaveLength(1);
 expect(stream.indexOf('Tj')).toBeLessThan(stream.indexOf('EMC'));expect(stream).toContain('1 Tr');
 const native=openPdfium(resolve('vendor/pdfium/linux-x64/lib/libpdfium.so'));
 try{
  const after=await f.doc.save(),a=native.inspectPage(before,0,true),b=native.inspectPage(after,0,true);
  expect(b.text.replace(/\s/g,'')).toContain('longnewwords');expect(b.text).not.toContain('ABCDE');
  const keep=(g:typeof a.glyphs[number])=>g.origin[1]>=150;
  expect(b.glyphs.filter(keep).map(g=>[g.text,g.fontHash,g.origin])).toEqual(a.glyphs.filter(keep).map(g=>[g.text,g.fontHash,g.origin]));
  expect(b.glyphs.filter(g=>g.origin[1]<150&&g.text.trim()).every(g=>g.inkPixels!>0&&g.nativePath?.length)).toBe(true);
  const dir='test-artifacts/retypeset-forms';await mkdir(dir,{recursive:true});await writeFile(`${dir}/form.before.pdf`,before);await writeFile(`${dir}/form.after.pdf`,after);
  const oracle=await auditCorpusSample(native,'form',dir,edit,{},true,undefined,r.outcomes[0]);
  expect(oracle).toMatchObject({passed:true,oracleTier:'retypeset',changedPixelsOutsideRetypesetMask:0,qpdf:'clean'});
  await writeFile(`${dir}/report.json`,JSON.stringify({command:'bun test src/pdf/export/contentText/retypesetForms.test.ts',outcomes:r.outcomes,nativeText:b.text,oracle,untargetedGlyphs:b.glyphs.filter(keep).length},null,2));
 }finally{native.close();}
});
test('shared page resources and form streams remain identical on the other page',async()=>{
 const f=await formFixture(),other=f.doc.addPage([300,200]);other.node.set(PDFName.of('Resources'),f.page.node.Resources()!);other.node.set(PDFName.of('Contents'),f.page.node.get(PDFName.of('Contents'))!);
 const before=await f.doc.save(),r=await applyContentTextEdits(f.page,[overlay({text:'long new words'})],{loadFont});
 expect(r.outcomes[0]?.mode).toBe('retypeset');expect(usedForm(other).ref).toEqual(f.ref);expect(usedForm(f.page).ref).not.toEqual(f.ref);
 const native=openPdfium(resolve('vendor/pdfium/linux-x64/lib/libpdfium.so'));
 try{const a=native.inspectPage(before,1,true),b=native.inspectPage(await f.doc.save(),1,true);expect(b.text).toBe(a.text);expect(b.pixels).toEqual(a.pixels);}finally{native.close();}
});
test('two uses of one form isolate only the selected Do and compose edits in that occurrence',async()=>{
 const f=await formFixture('q 1 0 0 1 0 0 cm /Fm Do Q q 1 0 0 1 0 -70 cm /Fm Do Q','BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET');
 const r=await applyContentTextEdits(f.page,[overlay({id:'one',originalText:'A',text:'new words',coverRects:[{x:49,y:98,w:8,h:13}]}),overlay({id:'two',originalText:'D',text:'extra words',coverRects:[{x:67.9,y:98,w:6.2,h:13}]})],{loadFont});
 expect(r.outcomes.map(o=>o.mode)).toEqual(['retypeset','retypeset']);
 const native=openPdfium(resolve('vendor/pdfium/linux-x64/lib/libpdfium.so'));
 try{const b=native.inspectPage(await f.doc.save());expect(b.text.replace(/\s/g,'')).toContain('newwordsBCextrawordsE');expect(b.glyphs.filter(g=>g.origin[1]===30).map(g=>g.text).join('')).toBe('ABCDE');}finally{native.close();}
});
test('nested form paths copy ancestors and respect form Matrix plus page Do CTM',async()=>{
 const f=await formFixture('q 0.5 0 0 0.5 20 30 cm /Fm Do Q','/Child Do');
 const resources=f.raw.dict.lookup(PDFName.of('Resources'),PDFDict),child=f.doc.context.stream(new TextEncoder().encode('BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET'),{Type:'XObject',Subtype:'Form',BBox:[0,0,300,200],Matrix:[1,0,0,1,10,20],Resources:resources.clone()});
 const ref=f.doc.context.register(child);resources.set(PDFName.of('XObject'),f.doc.context.obj({Child:ref}));
 const r=await applyContentTextEdits(f.page,[overlay({text:'long new words',coverRects:[{x:49,y:89,w:17,h:7}]})],{loadFont});expect(r.outcomes[0]?.mode).toBe('retypeset');
 expect(decoded(child)).toContain('(ABCDE)');expect(decoded(f.raw)).toBe('/Child Do');
 const native=openPdfium(resolve('vendor/pdfium/linux-x64/lib/libpdfium.so'));
 try{const b=native.inspectPage(await f.doc.save());expect(b.text.replace(/\s/g,'')).toBe('longnewwords');expect(b.glyphs[0]?.origin).toEqual([50,90]);}finally{native.close();}
});
test('inherited invisible OCR in a form over an image remains unsupported',async()=>{
 const f=await formFixture('3 Tr /Fm Do','q 300 0 0 200 0 0 cm /Image Do Q BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET');
 const resources=f.raw.dict.lookup(PDFName.of('Resources'),PDFDict),image=f.doc.context.register(f.doc.context.stream(Uint8Array.of(128),{Type:'XObject',Subtype:'Image',Width:1,Height:1,ColorSpace:'DeviceGray',BitsPerComponent:8}));
 resources.set(PDFName.of('XObject'),f.doc.context.obj({Image:image}));
 const before=inspectRunPage(f.page),r=await applyContentTextEdits(f.page,[overlay({text:'long new words'})],{loadFont});
 expect(r.outcomes[0]).toMatchObject({mode:'unsupported',reason:'unsupported-image-text'});expect(inspectRunPage(f.page)).toEqual(before);expect(usedForm(f.page).ref).toEqual(f.ref);
});
for(const body of ['BT /F1 10 Tf (unterminated','BT /Missing 10 Tf 50 100 Td (ABCDE) Tj ET','/Fm Do'])test(`unverifiable form fails closed: ${body}`,async()=>{
 const f=await formFixture('/Fm Do',body);if(body==='/Fm Do')f.raw.dict.set(PDFName.of('Resources'),f.page.node.Resources()!);
 const before=inspectRunPage(f.page),r=await applyContentTextEdits(f.page,[overlay({text:'long new words'})],{loadFont});
 expect(r.outcomes[0]?.mode).toBe('unsupported');expect(r.outcomes[0]?.detail).toBeTruthy();expect(inspectRunPage(f.page)).toEqual(before);expect(usedForm(f.page).ref).toEqual(f.ref);
});

test('inherited font, size and rotated Form Matrix keep replacement placement',async()=>{
 const f=await formFixture('/F1 10 Tf /Fm Do','BT 50 100 Td (ABCDE) Tj ET');
 f.raw.dict.set(PDFName.of('Matrix'),f.doc.context.obj([0,1,-1,0,200,0]));
 const r=await applyContentTextEdits(f.page,[overlay({text:'long new words',coverRects:[{x:89,y:49,w:13,h:32}]})],{loadFont});
 expect(r.outcomes[0]?.mode).toBe('retypeset');
 const native=openPdfium(resolve('vendor/pdfium/linux-x64/lib/libpdfium.so'));
 try{const b=native.inspectPage(await f.doc.save());expect(b.text.replace(/\s/g,'')).toBe('longnewwords');expect(b.glyphs[0]?.origin).toEqual([100,50]);expect(b.glyphs.every(g=>g.fontSize===10)).toBe(true);}finally{native.close();}
});
test('text outside Form BBox and singular matrices cannot authorize removal',async()=>{
 for(const key of ['BBox','Matrix']){
  const f=await formFixture();f.raw.dict.set(PDFName.of(key),f.doc.context.obj(key==='BBox'?[0,0,20,20]:[0,0,0,0,0,0]));
  const r=await applyContentTextEdits(f.page,[overlay({text:'long new words'})],{loadFont});expect(r.outcomes[0]?.mode).toBe('unsupported');expect(usedForm(f.page).ref).toEqual(f.ref);
 }
});
test('a changed form resource during asynchronous preparation never installs a stale copy',async()=>{
 const f=await formFixture('/Fm Do','BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET');
 const r=await applyContentTextEdits(f.page,[overlay({text:'é new words'})],{loadFont:async name=>{
  f.raw.dict.set(PDFName.of('Matrix'),f.doc.context.obj([1,0,0,1,1,0]));return loadFont(name);
 }});
 expect(r.outcomes[0]).toMatchObject({mode:'unsupported',reason:'unsupported-unwritable'});expect(r.outcomes[0]?.detail).toContain('changed');expect(usedForm(f.page).ref).toEqual(f.ref);
});

test('uncertain image Form bounds cannot authorize editing page OCR',async()=>{
 const f=await fixture('/Scan Do BT /F1 10 Tf 3 Tr 50 100 Td (ABCDE) Tj ET');
 const image=f.doc.context.register(f.doc.context.stream(Uint8Array.of(128),{Type:'XObject',Subtype:'Image',Width:1,Height:1,ColorSpace:'DeviceGray',BitsPerComponent:8}));
 const form=f.doc.context.register(f.doc.context.stream(new TextEncoder().encode('300 0 0 200 0 0 cm /Image Do'),{Type:'XObject',Subtype:'Form',Resources:{XObject:{Image:image}}}));
 f.page.node.Resources()!.set(PDFName.of('XObject'),f.doc.context.obj({Scan:form}));
 const before=inspectRunPage(f.page),r=await applyContentTextEdits(f.page,[overlay({text:'long new words'})],{loadFont});
 expect(r.outcomes[0]).toMatchObject({mode:'unsupported',reason:'unsupported-image-text'});expect(inspectRunPage(f.page)).toEqual(before);
});

test('fractional TJ kerning preserves untargeted form glyph positions',async()=>{
 const size=11.9551681196,x=273.7252449-4*.6*size+17.993927002/1000*size;
 const f=await formFixture('/Fm Do',`BT /F1 ${size} Tf ${x.toFixed(10)} 100 Td [(Astr) 17.993927002 (ophysics)] TJ ET`);
 f.raw.dict.set(PDFName.of('BBox'),f.doc.context.obj([0,0,500,200]));
 const r=await applyContentTextEdits(f.page,[overlay({originalText:'Astr',text:'long new words',coverRects:[{x:x-.05,y:99,w:29,h:14}]})],{loadFont});
 expect(r.outcomes[0]).toMatchObject({mode:'retypeset',fidelity:'approximate'});
});
