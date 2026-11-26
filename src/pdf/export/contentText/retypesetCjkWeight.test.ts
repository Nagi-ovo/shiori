import {expect,test} from 'bun:test';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {PDFArray,PDFDict,PDFName} from 'pdf-lib';
import {fixture,overlay} from './fixtures.test-support';
import {originalFallbackFace,retypesetFontSelector} from './retypesetFontSelection';
import {applyContentTextEdits} from './apply';
import {prepareFallback} from '../contentStreamEdit/fallbackFont';
import {openPdfium} from '../../../../scripts/pdf-inplace/nativePdfium';
import {readSavedGlyphs} from '../../../../scripts/pdf-inplace/oracleGlyphs';

// Failure list is recorded in STATUS.md before these tests and the fix.
const loadFont=(name:string)=>readFile(name.startsWith('Noto')?`src/assets/fonts/${name}`:`node_modules/@docx-editor.dev/fonts/assets/${name}`);
const regions=[['SC','新的文字'],['JP','かなカナ'],['KR','한국어한글']] as const;
const directory='test-artifacts/retypeset-fonts-r23';
const command='bun test src/pdf/export/contentText/retypesetCjkWeight.test.ts';

for(const [region,text]of regions)for(const [label,base,descriptor,style]of [
 ['regular','SourceSans-Regular',{Flags:32},'Regular'],
 ['medium','SourceSans-Medium',{Flags:32,FontWeight:500},'Regular'],
 ['italic-only','SourceSans-Italic',{Flags:32|64},'Regular'],
 ['bold','ABCDEF+SourceSans-Bold',{Flags:32},'Bold'],
 ['black','SourceSans-Black',{Flags:32},'Bold'],
 ['heavy','SourceSans-Heavy',{Flags:32},'Bold'],
 ['force-bold','Unknown',{Flags:32|(1<<18)},'Bold'],
 ['weight-600','Unknown',{Flags:32,FontWeight:600},'Bold'],
 ['weight-900','Unknown',{Flags:32,FontWeight:900},'Bold'],
 ['descriptor-name','Unknown',{Flags:32,FontName:'SourceSans-Bold'},'Bold'],
 ['descriptor-family','Unknown',{Flags:32,FontFamily:'SourceSans Heavy'},'Bold'],
]as const)test(`${region} ${label} selects ${style}`,async()=>{
 const f=await fixture();
 const font=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict);
 font.set(PDFName.of('BaseFont'),PDFName.of(base));
 font.set(PDFName.of('FontDescriptor'),f.doc.context.obj(descriptor));
 expect(originalFallbackFace(f.page,'F1',text)).toBe(`NotoSans${region}-${style}.otf`);
});

test('CID descendant weight and later CJK runs retain their own styles',async()=>{
 const f=await fixture('BT /F1 10 Tf 1 Tr 50 100 Td (AB) Tj /F2 10 Tf <004300440045> Tj ET');
 const fonts=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict);
 fonts.set(PDFName.of('F2'),f.doc.context.register(f.doc.context.obj({
  Type:'Font',Subtype:'Type0',BaseFont:'Unknown',Encoding:'Identity-H',
  DescendantFonts:[{Type:'Font',Subtype:'CIDFontType2',BaseFont:'Unknown',DW:600,CIDToGIDMap:'Identity',FontDescriptor:{Flags:32,FontWeight:700}}],
  ToUnicode:f.doc.context.register(f.doc.context.stream('1 beginbfrange <0043> <0045> <0043> endbfrange')),
 })));
 expect(originalFallbackFace(f.page,'F1','新的文字')).toBe('NotoSansSC-Regular.otf');
 expect(originalFallbackFace(f.page,'F2','新的文字')).toBe('NotoSansSC-Bold.otf');
 const result=await applyContentTextEdits(f.page,[overlay({text:'AB新DE'})],{loadFont,stage5Reflow:false});
 expect(result.outcomes[0]).toMatchObject({mode:'retypeset',retypeset:{substituteFont:'NotoSansSC-Bold.otf'}});
});

test('bold JP coverage holes prefer bold SC',async()=>{
 const selected=await retypesetFontSelector({loadFont})('NotoSansJP-Bold.otf','かな需要调整',Array.from('かな需要调整'));
 expect(selected.map(f=>f.name)).toEqual(['NotoSansSC-Bold.otf']);
});

test('regular remains available when every bold candidate lacks a scalar',async()=>{
 // Supply real, sparse official font bytes through the supported loader seam
 // to exercise a future Bold cmap hole (the shipped pairs share coverage).
 const selected=await retypesetFontSelector({loadFont:name=>loadFont(name.endsWith('-Bold.otf')?'NotoSansMath-Regular.ttf':name)})(
  'NotoSansSC-Bold.otf','调',['调']);
 expect(selected.map(f=>f.name)).toEqual(['NotoSansSC-Regular.otf']);
});

for(const [region,text]of regions)for(const style of ['Regular','Bold']as const)test(`native saved ${region} ${style} has searchable outlines`,async()=>{
 const f=await fixture();
 const name=`NotoSans${region}-${style}.otf`;
 const source=await prepareFallback(f.doc,'F1',name,Array.from('ABCDE'),{loadFont});
 f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).set(PDFName.of('F1'),source.ref);
 const font=f.doc.context.lookup(source.ref,PDFDict);
 // Retain genuine source outlines; a non-style-bearing subset BaseFont
 // ensures the CID descriptor's FontName is the source of the weight hint.
 font.set(PDFName.of('BaseFont'),PDFName.of('Unknown'));
 const cid=font.lookup(PDFName.of('DescendantFonts'),PDFArray).lookup(0,PDFDict);
 cid.set(PDFName.of('BaseFont'),PDFName.of('Unknown'));
 cid.lookup(PDFName.of('FontDescriptor'),PDFDict).set(PDFName.of('FontName'),PDFName.of(`SourceSans-${style}`));
 const encoded=source.resolved.canEncode!('ABCDE');if(!encoded.ok)throw Error(encoded.reason);
 // Source stroke mode forces the existing approximate path, as in r22;
 // the picker does not synthesize stroke or alter rendering mode.
 f.page.node.set(PDFName.of('Contents'),f.doc.context.register(f.doc.context.stream(`BT /F1 10 Tf 1 Tr 50 100 Td <${Buffer.from(encoded.bytes).toString('hex')}> Tj ET`)));
 const before=await f.doc.save(),result=await applyContentTextEdits(f.page,[overlay({text})],{loadFont,stage5Reflow:false});
 expect(result.outcomes[0]).toMatchObject({mode:'retypeset',retypeset:{substituteFont:name}});
 const after=await f.doc.save({useObjectStreams:false}),saved=await readSavedGlyphs(after);
 expect(saved.glyphs.map(g=>g.unicode).join('')).toBe(text);
 expect(saved.glyphs.every(g=>g.glyphId!==undefined&&g.glyphId>0)).toBe(true);
 const native=openPdfium('vendor/pdfium/linux-x64/lib/libpdfium.so');
 try{
  const observed=native.inspectPage(after,0,true);
  expect(observed.text.replace(/\s/gu,'')).toBe(text);
  expect(observed.glyphs.filter(g=>g.text.trim()).every(g=>g.nativePath?.length&&g.inkPixels!>0)).toBe(true);
  const path=`${directory}/${region}-${style}`;
  await mkdir(directory,{recursive:true});
  await writeFile(`${directory}/README.md`,`Regenerate: ${command}\nSynthetic saved PDF/native checks; no official corpus oracle changes.\n`);
  await writeFile(`${path}.before.pdf`,before);await writeFile(`${path}.after.pdf`,after);
  await writeFile(`${path}.json`,JSON.stringify({command,outcome:result.outcomes[0],nativeText:observed.text,glyphs:observed.glyphs,savedGlyphs:saved.glyphs},null,2));
 }finally{native.close();}
});
