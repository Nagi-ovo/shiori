import {expect,test} from 'bun:test';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {PDFArray,PDFDict,PDFDocument,PDFName,PDFNumber,PDFString} from 'pdf-lib';
import {exportPdf} from '../exportPdf';
import {prepareFallback} from '../contentStreamEdit/fallbackFont';
import {hex} from '../contentStreamEdit/runEncoding';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {readSavedGlyphs} from '../../../../scripts/pdf-inplace/oracleGlyphs';
import {openPdfium} from '../../../../scripts/pdf-inplace/nativePdfium';
import {applyContentTextEdits} from './apply';
import {bytes,fixture,model,overlay} from './fixtures.test-support';
import {verticalFixture} from './vertical.fixture.test';
import {applyUprightColumnRetypesets} from './uprightColumn';
import {columnEdit,pageColumns} from './uprightColumn.fixture.test';
import type {ContentTextOutcome} from './outcomes';
import {readRetypesetSource} from './retypesetSource';

// Writer failures: a Latin-only hole ignores eligible local programs, equal
// local display names conflate styles, and neutral vertical
// glyphs lack vertical advances, ignore source ordering or language, or use
// a different region's program to bypass the alternate proof.
const name=PDFName.of;
const loadFont=(file:string)=>readFile(file.startsWith('Noto')? `src/assets/fonts/${file}`:`node_modules/@docx-editor.dev/fonts/assets/${file}`);

// A five-glyph source line has 30 pt at 10 pt. The two real bundled
// programs both wrap five Qs, but only Carlito can put four on the first line.
// A single accent fits either program and should keep the primary face.
for(const [text,face,baselines,advance] of [
 ['QQQQQ','LiberationSans-Regular.ttf',[100,100,100,88,88],778],
 ['AéCDE','Carlito-Regular.ttf',[100,100,100,100,100],498],
] as const)test(`saved retypeset with a metric-compatible substitute preserves line allocation for ${text}`,async()=>{
 const {doc,page}=await fixture();
 const source=await prepareFallback(doc,'F1','LiberationMono-Regular.ttf',Array.from('ABCDE'),{loadFont});
 const sourceDict=doc.context.lookup(source.ref,PDFDict);
 sourceDict.set(name('BaseFont'),name('Calibri'));
 const descendant=sourceDict.lookup(name('DescendantFonts'),PDFArray).lookup(0,PDFDict);
 descendant.lookup(name('FontDescriptor'),PDFDict).set(name('Flags'),PDFNumber.of(32));
 page.node.set(name('Resources'),doc.context.obj({Font:{F1:source.ref}}));
 const encoded=source.resolved.canEncode!('ABCDE');
 if(!encoded.ok)throw Error(encoded.reason);
 page.node.set(name('Contents'),doc.context.register(doc.context.stream(
  `BT /F1 10 Tf 1 Tr 50 100 Td ${hex(encoded.bytes)} Tj 0 -60 Td ${hex(encoded.bytes)} Tj ET`,
 )));
 const edits=[overlay({text}),overlay({id:'second',text:'éBCDE',coverRects:[{x:49,y:38,w:32,h:13}]})];
 const result=await exportPdf(await doc.save(),model(edits),{mode:'flatten',stage5Reflow:false,inPlaceFallback:{loadFont}});
 expect(result.contentTextOutcomes?.[0]).toMatchObject({mode:'retypeset',retypeset:{substituteFont:face,lineCount:new Set(baselines).size}});
 expect(result.contentTextOutcomes?.[1]).toMatchObject({mode:'retypeset',retypeset:{substituteFont:'Carlito-Regular.ttf',lineCount:1}});
 const saved=await PDFDocument.load(result.bytes),out=saved.getPage(0),content=inspectRunPage(out);
 if(!content.ok)throw Error(content.reason);
 const glyphs=readRetypesetSource(out,tokenizeContentStream(content.bytes)).glyphs;
 expect(glyphs.map(g=>g.text).join('')).toBe(text+'éBCDE');
 expect(glyphs.map(g=>g.y)).toEqual([...baselines,40,40,40,40,40]);
 expect(glyphs.find(g=>g.text===text[1])?.glyph.tjCompensation).toBe(advance);
});

test('saved retypeset uses both exact local programs when their supplied names match',async()=>{
 const {doc,page}=await fixture();
 const source=await prepareFallback(doc,'F1','LiberationSans-Regular.ttf',Array.from('ABCDE'),{loadFont});
 const regular=doc.context.lookup(source.ref,PDFDict);
 regular.set(name('BaseFont'),name('Carlito'));
 const bold=regular.clone();
 bold.set(name('BaseFont'),name('Carlito-Bold'));
 page.node.set(name('Resources'),doc.context.obj({Font:{F1:source.ref,F2:doc.context.register(bold)}}));
 const encode=(text:string)=>{
  const encoded=source.resolved.canEncode!(text);if(!encoded.ok)throw Error(encoded.reason);
  return hex(encoded.bytes);
 };
 page.node.set(name('Contents'),doc.context.register(doc.context.stream(
  `BT 1 Tr /F1 10 Tf 50 100 Td ${encode('AB')} Tj /F2 10 Tf ${encode('CD')} Tj /F1 10 Tf ${encode('E')} Tj ET`,
 )));
 const localFonts=await Promise.all(['Regular','Bold'].map(async style=>({name:'same-name',bytes:await loadFont(`Carlito-${style}.ttf`)})));
 const before=await doc.save(),original=await readSavedGlyphs(before);
 const edits=[
  overlay({id:'regular',originalText:'B',text:'é',coverRects:[{x:56.65,y:98,w:6.7,h:13}]}),
  overlay({id:'bold',originalText:'D',text:'é',coverRects:[{x:70.55,y:98,w:7.26,h:13}]}),
 ];
 const result=await exportPdf(before,model(edits),{mode:'flatten',stage5Reflow:false,inPlaceFallback:{loadFont,localFonts}});
 expect(result.contentTextOutcomes).toHaveLength(2);
 for(const outcome of result.contentTextOutcomes!)expect(outcome).toMatchObject({mode:'retypeset',retypeset:{substituteFont:'same-name'}});
 const saved=await readSavedGlyphs(result.bytes),out=await PDFDocument.load(result.bytes);
 expect(saved.glyphs.map(g=>g.unicode).join('')).toBe('AéCéE');
 const local=saved.glyphs.filter(g=>g.unicode==='é');
 expect(new Set(local.map(g=>saved.fontHashes[g.fontObject])).size).toBe(2);
 for(const g of local){
  expect(g.glyphId).toBeGreaterThan(0);
  const font=out.context.enumerateIndirectObjects().find(([ref])=>ref.toString()===g.fontObject)?.[1] as PDFDict;
  expect(font.lookup(name('BaseFont'),PDFName).decodeText()).toMatch(/^[A-Z]{6}\+Carlito$/u);
 }
 expect(new Set(saved.glyphs.filter(g=>g.unicode!=='é').map(g=>saved.fontHashes[g.fontObject])))
  .toEqual(new Set(Object.values(original.fontHashes)));
});

test('vertical fallback embeds the eligible local program under its real family',async()=>{
 const f=await verticalFixture({text:'日本語'});
 f.raw.set(name('BaseFont'),name('NotoSansJP-Regular'));
 const localFonts=[{name:'local-vertical',bytes:await loadFont('NotoSansJP-Regular.otf')}];
 const result=await applyContentTextEdits(f.page,[{...f.edit,text:'日骨語'}],{loadFont,localFonts});
 expect(result.outcomes[0]).toMatchObject({mode:'retypeset',retypeset:{substituteFont:'local-vertical'}});
 const font=f.page.node.Resources()!.lookup(name('Font'),PDFDict).lookup(name('ShioriV1'),PDFDict);
 expect(font.lookup(name('BaseFont'),PDFName).decodeText()).toMatch(/^[A-Z]{6}\+NotoSansJP$/u);
 expect(font.lookup(name('Encoding'),PDFName).decodeText()).toBe('Identity-V');
 const saved=await readSavedGlyphs(await f.doc.save());
 expect(saved.glyphs.map(g=>g.unicode).join('')).toBe('日骨語');
});

test('saved Japan1 digit-only column embeds a searchable vertical glyph and retains the source program',async()=>{
 const f=await verticalFixture({text:'１２４'});
 f.child.lookup(name('CIDSystemInfo'),PDFDict).set(name('Ordering'),PDFString.of('Japan1'));
 f.doc.catalog.set(name('Lang'),PDFString.of('zh-CN'));
 const before=await f.doc.save(),original=await readSavedGlyphs(before),edit={...f.edit,text:'１３４'};
 const document=model([edit]);document.pages[0]!.heightPt=240;
 const unedited=await exportPdf(before,{...document,overlays:[]},{mode:'flatten',inPlaceFallback:{loadFont}});
 expect(unedited.bytes).toEqual(before);
 const result=await exportPdf(before,document,{mode:'flatten',inPlaceFallback:{loadFont}});
 expect(result.contentTextOutcomes?.[0]).toMatchObject({mode:'retypeset',retypeset:{substituteFont:'NotoSansJP-Regular.otf'}});
 const out=await PDFDocument.load(result.bytes),saved=await readSavedGlyphs(result.bytes);
 const font=out.getPage(0).node.Resources()!.lookup(name('Font'),PDFDict).lookup(name('ShioriV1'),PDFDict);
 const child=font.lookup(name('DescendantFonts'),PDFArray).lookup(0,PDFDict);
 expect(font.lookup(name('Encoding'),PDFName).decodeText()).toBe('Identity-V');
 expect(child.lookup(name('DW2'),PDFArray).size()).toBe(2);
 expect(child.lookup(name('W2'),PDFArray).lookup(1,PDFArray).size()).toBe(3);
 expect(saved.glyphs.map(g=>g.unicode).join('')).toBe(edit.text);
 expect(saved.glyphs[1]!.glyphId).toBeGreaterThan(0);
 for(const i of [0,2])expect(saved.fontHashes[saved.glyphs[i]!.fontObject]).toBe(original.fontHashes[original.glyphs[i]!.fontObject]!);
 const native=openPdfium('vendor/pdfium/linux-x64/lib/libpdfium.so');
 try{
  const page=native.inspectPage(result.bytes,0,true);
  expect(page.text.replace(/\s/gu,'')).toBe(edit.text);
  expect(page.glyphs[1]!.inkPixels).toBeGreaterThan(0);
 }finally{native.close();}
 const output='test-artifacts/r4-neutral-vertical';
 await mkdir(output,{recursive:true});
 await writeFile(`${output}/before.pdf`,before);
 await writeFile(`${output}/after.pdf`,result.bytes);
 await writeFile(`${output}/result.json`,JSON.stringify({
  command:'bun test src/pdf/export/contentText/fontWriters.test.ts -t "saved Japan1 digit-only column"',
  outcome:result.contentTextOutcomes?.[0],glyphs:saved.glyphs,fontHashes:saved.fontHashes,
 },null,2));
});

for(const [ordering,lang,source,text,expected] of [
 ['GB1','ja','１２４','１３４','NotoSansSC-Regular.otf'],
 ['GB1',undefined,'12','3','NotoSansSC-Regular.otf'],
 ['Japan1',undefined,'BC','A','NotoSansJP-Regular.otf'],
 ['CNS1','ja','ㄅㄇㄈ','ㄅㄆㄈ','NotoSansSC-Regular.otf'],
 ['Identity','ko','１２４','１３４','NotoSansKR-Regular.otf'],
 ['Identity',undefined,'１２４','１３４','NotoSansSC-Regular.otf'],
] as const)test(`vertical ${text} uses ${expected} for ${ordering}/${lang}`,async()=>{
 const f=await verticalFixture({text:source});
 f.child.lookup(name('CIDSystemInfo'),PDFDict).set(name('Ordering'),PDFString.of(ordering));
 if(/^\p{ASCII}+$/u.test(source)){
  f.child.set(name('W2'),f.doc.context.obj(Array.from(source).flatMap(c=>[parseInt(f.code(c).slice(1,-1),16),[-1000,280,880]])));
 }
 if(lang)f.doc.catalog.set(name('Lang'),PDFString.of(lang));
 const result=await applyContentTextEdits(f.page,[{...f.edit,text}],{loadFont});
 expect(result.outcomes[0]).toMatchObject({mode:'retypeset',retypeset:{substituteFont:expected}});
 const saved=await readSavedGlyphs(await f.doc.save());
 expect(saved.glyphs.map(g=>g.unicode).join('')).toBe(text);
 expect(saved.glyphs.every(g=>g.glyphId!>0)).toBe(true);
});

test.each(['absent','malformed'])('a local face with %s vertical tables does not bypass the metric proof',async kind=>{
 const f=await verticalFixture({text:'BC'});
 f.child.set(name('W2'),f.doc.context.obj([1,[ -1000,300,880,-1000,300,880]]));
 f.raw.set(name('BaseFont'),name('NotoSansJP-Bold'));
 f.child.lookup(name('CIDSystemInfo'),PDFDict).set(name('Ordering'),PDFString.of('GB1'));
 const regular=await loadFont('NotoSansJP-Regular.otf');
 const bold=await loadFont('NotoSansJP-Bold.otf');
 for(const tag of kind==='absent'?['vhea','vmtx','VORG']:['vhea'])bold[bold.indexOf(tag,12)]=0x78;
 const localFonts=[{name:'local-bold',bytes:bold},{name:'local-regular',bytes:regular}];
 const before=inspectRunPage(f.page),result=await applyContentTextEdits(f.page,[{...f.edit,text:'A'}],{loadFont,localFonts});
 if(kind==='absent'){
  expect(result.outcomes[0]).toMatchObject({mode:'retypeset',retypeset:{substituteFont:'local-regular'}});
 }else{
  expect(result.outcomes[0]).toMatchObject({mode:'unsupported',reason:'unsupported-vertical-writing'});
  expect(result.outcomes[0]?.detail).toContain('malformed or missing sfnt vertical tables');
  expect(inspectRunPage(f.page)).toEqual(before);
 }
});

test('a neutral GB1 vertical glyph must pass the SC alternate proof',async()=>{
 const f=await verticalFixture({text:'１２４'});
 f.child.lookup(name('CIDSystemInfo'),PDFDict).set(name('Ordering'),PDFString.of('GB1'));
 f.doc.catalog.set(name('Lang'),PDFString.of('ja'));
 const before=inspectRunPage(f.page),loaded:string[]=[];
 const result=await applyContentTextEdits(f.page,[{...f.edit,text:'１！４'}],{
  loadFont:file=>{loaded.push(file);return loadFont(file);},
 });
 expect(result.outcomes[0]).toMatchObject({mode:'unsupported',reason:'unsupported-vertical-writing'});
 expect(result.outcomes[0]?.detail).toContain('requires a vertical alternate');
 expect(loaded).toEqual(['NotoSansSC-Regular.otf']);
 expect(inspectRunPage(f.page)).toEqual(before);
});

for(const [ordering,text] of [['Japan1','１３４'],['GB1','１！４']] as const)
test(`upright ${ordering} resolves and proves the missing glyph in ${text}`,async()=>{
 const {page,doc}=await fixture();
 const source=await prepareFallback(doc,'F1','NotoSansJP-Regular.otf',Array.from('１２４'),{loadFont});
 const child=doc.context.lookup(source.ref,PDFDict).lookup(name('DescendantFonts'),PDFArray).lookup(0,PDFDict);
 child.lookup(name('CIDSystemInfo'),PDFDict).set(name('Ordering'),PDFString.of(ordering));
 doc.catalog.set(name('Lang'),PDFString.of('zh-CN'));
 page.node.set(name('Resources'),doc.context.obj({Font:{F1:source.ref}}));
 const shows=Array.from('１２４',c=>{
  const code=source.resolved.canEncode!(c);if(!code.ok)throw Error(code.reason);
  return `${hex(code.bytes)} Tj`;
 }).join(' 0 -16 Td ');
 page.node.set(name('Contents'),doc.context.register(doc.context.stream(`BT /F1 16 Tf 150 150 Td ${shows} ET`)));
 const {columns,box}=pageColumns(page),edit=columnEdit(columns[0]!,box,()=>text);
 const before=inspectRunPage(page),outcomes=new Map<string,ContentTextOutcome>();
 await applyUprightColumnRetypesets(page,[edit],outcomes,new Set(),{loadFont});
 if(ordering==='GB1'){
  expect(outcomes.get(edit.id)).toMatchObject({mode:'unsupported',reason:'unsupported-vertical-writing'});
  expect(outcomes.get(edit.id)?.detail).toContain('needs a vertical alternate');
  expect(inspectRunPage(page)).toEqual(before);
  return;
 }
 expect(outcomes.get(edit.id)).toMatchObject({mode:'retypeset',retypeset:{substituteFont:'NotoSansJP-Regular.otf'}});
 const saved=await readSavedGlyphs(await doc.save());
 expect(saved.glyphs.map(g=>g.unicode).join('')).toBe(edit.text);
 expect(saved.glyphs[1]!.glyphId).toBeGreaterThan(0);
});

test('a GB1 vertical paragraph proves missing punctuation on the SC program and refuses an unproved alternate',async()=>{
 const f=await verticalFixture({text:'日本i語'});
 const code=Number.parseInt(f.code('i').slice(1,-1),16);
 f.child.set(name('W2'),f.doc.context.obj([code,code,-1000,140,880]));
 f.child.lookup(name('CIDSystemInfo'),PDFDict).set(name('Ordering'),PDFString.of('GB1'));
 f.doc.catalog.set(name('Lang'),PDFString.of('ja'));
 const loaded:string[]=[];
 const source=inspectRunPage(f.page),resources=f.page.node.Resources();
 const result=await applyContentTextEdits(f.page,[{...f.edit,text:'日本i“'}],{
  loadFont:file=>{loaded.push(file);return loadFont(file);},
 });
 expect(result.outcomes[0]).toMatchObject({mode:'unsupported',reason:'unsupported-vertical-writing'});
 expect(result.outcomes[0]?.detail).toContain('requires a vertical alternate');
 expect(loaded).toEqual(['NotoSansSC-Regular.otf']);
 expect(inspectRunPage(f.page)).toEqual(source);
 expect(f.page.node.Resources()).toBe(resources);
});

for(const [text,lang,region] of [['日骨語','ko','KR'],['日“語','zh-Hans','SC']] as const)
test(`upright columns use their regional face for ${text}`,async()=>{
 const {page,doc}=await fixture('BT /F1 10 Tf 150 150 Td (A) Tj 0 -12 Td (B) Tj 0 -12 Td (C) Tj ET');
 doc.catalog.set(name('Lang'),PDFString.of(lang));
 const font=page.node.Resources()!.lookup(name('Font'),PDFDict).lookup(name('F1'),PDFDict);
 font.set(name('ToUnicode'),doc.context.register(doc.context.stream(bytes('3 beginbfchar <41> <65e5> <42> <672c> <43> <8a9e> endbfchar'))));
 const {columns,box}=pageColumns(page),edit=columnEdit(columns[0]!,box,()=>text);
 const loaded:string[]=[],outcomes=new Map<string,ContentTextOutcome>();
 const before=inspectRunPage(page);
 await applyUprightColumnRetypesets(page,[edit],outcomes,new Set(),{loadFont:file=>{loaded.push(file);return loadFont(file);}});
 const outcome=outcomes.get(edit.id);
 if(text.includes('“')){
  expect(outcome).toMatchObject({mode:'unsupported',reason:'unsupported-vertical-writing'});
  expect(outcome?.detail).toContain('needs a vertical alternate');
  expect(inspectRunPage(page)).toEqual(before);
 }else{
  expect(outcome).toMatchObject({mode:'retypeset',retypeset:{substituteFont:`NotoSans${region}-Regular.otf`}});
 }
 expect(loaded).toEqual([`NotoSans${region}-Regular.otf`]);
});

// A nominal code available in the source still needs the column proof when
// the eligible local face has no alternate for that scalar.
test('a local font cannot bypass the alternate refusal for an unobserved source code',async()=>{
 const {doc,page}=await fixture();
 const source=await prepareFallback(doc,'F1','NotoSansJP-Regular.otf',Array.from('日本語…'),{loadFont});
 doc.context.lookup(source.ref,PDFDict).set(name('BaseFont'),name('Carlito'));
 page.node.set(name('Resources'),doc.context.obj({Font:{F1:source.ref}}));
 const shows=Array.from('日本語',c=>{
  const code=source.resolved.canEncode!(c);if(!code.ok)throw Error(code.reason);
  return `${hex(code.bytes)} Tj`;
 }).join(' 0 -12 Td ');
 page.node.set(name('Contents'),doc.context.register(doc.context.stream(`BT /F1 10 Tf 150 150 Td ${shows} ET`)));
 const {columns,box}=pageColumns(page),edit=columnEdit(columns[0]!,box,()=> '日…語');
 const outcomes=new Map<string,ContentTextOutcome>(),before=inspectRunPage(page);
 const localFonts=[{name:'local-horizontal',bytes:await loadFont('Carlito-Regular.ttf')}];
 await applyUprightColumnRetypesets(page,[edit],outcomes,new Set(),{loadFont,localFonts});
 expect(outcomes.get(edit.id)).toMatchObject({mode:'unsupported',reason:'unsupported-vertical-writing'});
 expect(outcomes.get(edit.id)?.detail).toContain('needs a vertical alternate');
 expect(inspectRunPage(page)).toEqual(before);
});
