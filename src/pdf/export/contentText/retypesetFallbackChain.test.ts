import {expect,test} from 'bun:test';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {PDFArray,PDFDict,PDFName} from 'pdf-lib';
import {fixture,overlay} from './fixtures.test-support';
import {applyContentTextEdits} from './apply';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import {prepareFallback} from '../contentStreamEdit/fallbackFont';
import {readSavedGlyphs} from '../../../../scripts/pdf-inplace/oracleGlyphs';
import {openPdfium} from '../../../../scripts/pdf-inplace/nativePdfium';

// Failure list before the fix: descriptor-only bold/italic/serif; source
// FontName and FontWeight on CID descendants; a later run differing from the
// paragraph's first run; JP lacking simplified 调; math h/rho; NFC's canonical
// U+2329 -> U+3008 bracket; Hangul syllables; mixed CJK/math/symbol faces;
// an uncovered scalar must refuse atomically. Native saved glyphs must have
// real outlines, and Unicode must survive without compatibility folding.
const loadFont=(name:string)=>readFile(name.startsWith('Noto')?`src/assets/fonts/${name}`:`node_modules/@docx-editor.dev/fonts/assets/${name}`);
const directory='test-artifacts/retypeset-fonts-r22';
const command='bun test src/pdf/export/contentText/retypesetFallbackChain.test.ts';

for(const [label,base,descriptor,expected]of [
 ['weight','Unknown',{Flags:32,FontWeight:700},'LiberationSans-Bold.ttf'],
 ['italic','Unknown',{Flags:32|64},'LiberationSans-Italic.ttf'],
 ['serif-bold-italic','Unknown',{Flags:2|64,FontWeight:700},'LiberationSerif-BoldItalic.ttf'],
 ['descriptor-name','Unknown',{Flags:32,FontName:'Times-Bold'},'LiberationSerif-Bold.ttf'],
 ['mincho','SourceMincho',{Flags:32},'LiberationSerif-Regular.ttf'],
 ['gothic','SourceGothic',{Flags:32},'LiberationSans-Regular.ttf'],
]as const)test(`retypeset preserves original ${label} style`,async()=>{
 const f=await fixture('BT /F1 10 Tf 1 Tr 50 100 Td (ABCDE) Tj ET');
 const font=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict);
 font.set(PDFName.of('BaseFont'),PDFName.of(base));
 font.set(PDFName.of('FontDescriptor'),f.doc.context.obj({Type:'FontDescriptor',...descriptor}));
 const result=await applyContentTextEdits(f.page,[overlay({text:'éééééé'})],{loadFont,stage5Reflow:false});
 expect(result.outcomes[0]).toMatchObject({mode:'retypeset',retypeset:{substituteFont:expected}});
});

test('a later bold run supplies its own style instead of the regular paragraph start',async()=>{
 const f=await fixture('BT /F1 10 Tf 1 Tr 50 100 Td (AB) Tj /F2 10 Tf (CDE) Tj ET');
 const fonts=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict),regular=fonts.lookup(PDFName.of('F1'),PDFDict);
 regular.set(PDFName.of('BaseFont'),PDFName.of('Helvetica'));
 const bold=regular.clone();bold.set(PDFName.of('FontDescriptor'),f.doc.context.obj({Flags:32,FontWeight:700}));
 fonts.set(PDFName.of('F2'),f.doc.context.register(bold));
 const result=await applyContentTextEdits(f.page,[overlay({text:'ABéDE'})],{loadFont,stage5Reflow:false});
 expect(result.outcomes[0]).toMatchObject({mode:'retypeset',retypeset:{substituteFont:'LiberationSans-Bold.ttf'}});
});

test('CID descendant descriptor supplies weight, italic flag and family hints',async()=>{
 const f=await fixture('BT /F1 10 Tf 1 Tr 50 100 Td <00410042004300440045> Tj ET');
 const font=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict);
 font.set(PDFName.of('Subtype'),PDFName.of('Type0'));font.set(PDFName.of('Encoding'),PDFName.of('Identity-H'));
 font.set(PDFName.of('BaseFont'),PDFName.of('Unknown'));
 font.set(PDFName.of('DescendantFonts'),f.doc.context.obj([{Type:'Font',Subtype:'CIDFontType2',BaseFont:'Unknown',DW:600,CIDToGIDMap:'Identity',FontDescriptor:{Flags:64,FontWeight:700,FontName:'SourceMincho'}}]));
 font.set(PDFName.of('ToUnicode'),f.doc.context.register(f.doc.context.stream('1 beginbfrange <0041> <0045> <0041> endbfrange')));
 expect(font.lookup(PDFName.of('DescendantFonts'),PDFArray).size()).toBe(1);
 const result=await applyContentTextEdits(f.page,[overlay({text:'éééééé'})],{loadFont,stage5Reflow:false});
 expect(result.outcomes[0]).toMatchObject({mode:'retypeset',retypeset:{substituteFont:'LiberationSerif-BoldItalic.ttf'}});
});

for(const [label,text,expected]of [
 ['jp-to-sc','かな需要调整','NotoSansSC-Bold.otf'],
 ['math','For ℎ,𝜌 > 0','NotoSansMath-Regular.ttf'],
 ['canonical-angle','281 〈/ctexheading〉','NotoSansSC-Regular.otf'],
 ['angle','281 〈/ctexheading〉','NotoSansSC-Regular.otf'],
 ['hangul','한국어 한글','NotoSansKR-Bold.otf'],
 ['han-style','新的文字','NotoSansSC-Bold.otf'],
 ['mixed-math-cjk-symbols','한글 调 ℎ𝜌 🂡',null],
]as const)test(`coverage chain emits searchable non-tofu glyphs: ${label}`,async()=>{
 const f=await fixture('BT /F1 10 Tf 1 Tr 50 100 Td (ABCDE) Tj ET');
 const embedded=await prepareFallback(f.doc,'F1','LiberationSans-BoldItalic.ttf',Array.from('ABCDE'),{loadFont});
 f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).set(PDFName.of('F1'),embedded.ref);
 const encoded=embedded.resolved.canEncode!('ABCDE');if(!encoded.ok)throw Error(encoded.reason);
 f.page.node.set(PDFName.of('Contents'),f.doc.context.register(f.doc.context.stream(`BT /F1 10 Tf 1 Tr 50 100 Td <${Buffer.from(encoded.bytes).toString('hex')}> Tj ET`)));
 const font=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict);
 font.set(PDFName.of('BaseFont'),PDFName.of('Helvetica-BoldOblique'));
 font.set(PDFName.of('FontDescriptor'),f.doc.context.obj({Flags:64,FontWeight:700}));
 const before=await f.doc.save(),result=await applyContentTextEdits(f.page,[overlay({text})],{loadFont,stage5Reflow:false});
 expect(result.outcomes[0]?.mode).toBe('retypeset');
 if(expected)expect(result.outcomes[0]?.retypeset?.substituteFont).toBe(expected);
 const after=await f.doc.save({useObjectStreams:false}),saved=await readSavedGlyphs(after);
 expect(saved.glyphs.map(g=>g.unicode).join('')).toBe(text.normalize('NFC'));
 expect(saved.glyphs.every(g=>g.glyphId!==undefined&&g.glyphId>0)).toBe(true);
 const native=openPdfium('vendor/pdfium/linux-x64/lib/libpdfium.so');
 try{
  const observed=native.inspectPage(after,0,true);
  expect(observed.text.replace(/\s/gu,'')).toBe(text.normalize('NFC').replace(/\s/gu,''));
  expect(observed.glyphs.filter(g=>g.text.trim()).every(g=>g.nativePath?.length&&g.inkPixels!>0)).toBe(true);
  await mkdir(directory,{recursive:true});
  await writeFile(`${directory}/README.md`,`Regenerate: ${command}\nSynthetic saved PDF/native checks; no official corpus oracle changes.\n`);
  await writeFile(`${directory}/${label}.before.pdf`,before);await writeFile(`${directory}/${label}.after.pdf`,after);
  await writeFile(`${directory}/${label}.json`,JSON.stringify({command,outcome:result.outcomes[0],nativeText:observed.text,glyphs:saved.glyphs},null,2));
 }finally{native.close();}
});

test('exhausting coverage leaves resources and content unchanged',async()=>{
 const f=await fixture('BT /F1 10 Tf 1 Tr 50 100 Td (ABCDE) Tj ET');
 const before=inspectRunPage(f.page),resources=f.page.node.Resources(),count=f.doc.context.enumerateIndirectObjects().length;
 const result=await applyContentTextEdits(f.page,[overlay({text:'调\u{10ffff}'})],{loadFont,stage5Reflow:false});
 expect(result.outcomes[0]?.mode).toBe('unsupported');
 expect(result.outcomes[0]?.detail).toContain('missing glyph');
 expect(inspectRunPage(f.page)).toEqual(before);expect(f.page.node.Resources()).toBe(resources);
 expect(f.doc.context.enumerateIndirectObjects()).toHaveLength(count);
});
