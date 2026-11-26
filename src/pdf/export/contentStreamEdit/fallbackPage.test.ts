import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFDict, PDFName, PDFArray, PDFRawStream, PDFRef, PDFString } from 'pdf-lib';
import { inspectRunPage } from './replaceRunPage';
import { replaceRunPageWithFallback } from './fallbackPage';
import { tinyTtf, sfnt } from '../fontCoverage/fixtures/programs';
import { sourceGlyphs, readSavedGlyphs } from '../../../../scripts/pdf-inplace/oracleGlyphs';
import { editMatrix } from '../../../../scripts/pdf-corpus/editMatrix';
import { prepareFallback } from './fallbackFont';
import { sourceFingerprint } from './replaceRun';
import { tokenizeContentStream } from './tokenizer';
import { readRetypesetSource } from '../contentText/retypesetSource';
const b = (s: string) => new TextEncoder().encode(s);
const loadFont = (name: string) => readFile(name.endsWith('.ttf') ? `node_modules/@docx-editor.dev/fonts/assets/${name}` : `src/assets/fonts/${name}`);
async function fixture(baseFont = 'AAAAAA+Arial', flags = 32) {
  const doc = await PDFDocument.create(), page = doc.addPage();
  const f = doc.context.register(doc.context.obj({ Type:'Font',Subtype:'TrueType',BaseFont:baseFont,FirstChar:65,Widths:[500,500],Encoding:'WinAnsiEncoding',
    FontDescriptor:doc.context.register(doc.context.obj({Flags:flags,FontFile2:doc.context.register(doc.context.flateStream(tinyTtf({maps:[{platform:3,encoding:1,entries:[[65,1],[66,2]]}]})))})),
    ToUnicode:doc.context.register(doc.context.stream(b('2 beginbfchar <41> <0041> <42> <0042> endbfchar'))) }));
  page.node.set(PDFName.of('Resources'),doc.context.obj({Font:{F1:f}}));
  page.node.set(PDFName.of('Contents'),doc.context.register(doc.context.stream(b('BT /F1 12 Tf 50 100 Td (AB) Tj (A) Tj ET'))));
  const info=inspectRunPage(page); if(!info.ok)throw Error(info.reason);
  const edit={fontResource:'F1',fontObject:f.toString(),opIndex:3,itemIndex:-1,byteStart:0,byteEnd:2,expected:b('AB'),replacement:'Aé'};
  return {doc,page,info,edit};
}

// A face can exceed the original slot, both faces can exceed the edit box,
// and a roomy slot should never need the alternate program.
for (const [label,baseFont,flags,availablePt,face,advance] of [
  ['only the alternate face fits','AAAAAA+Arial',34,6,'LiberationSerif-Regular.ttf',444],
  ['neither face fits','AAAAAA+Arial',34,5,undefined,undefined],
  ['the preferred face fits','AAAAAA+Calibri',32,6,'Carlito-Regular.ttf',498],
] as const) test(`cluster fit in ${availablePt} pt when ${label}`,async()=>{
  const {doc,page,info,edit}=await fixture(baseFont,flags);
  const resources=page.node.Resources();
  const result=await replaceRunPageWithFallback(page,{sourceHash:info.sourceHash,edits:[
    {...edit,byteStart:1,expected:b('B'),replacement:'é',availablePt},
  ]},{loadFont});
  if(!face){
    expect(result).toMatchObject({ok:false,code:'overflow'});
    expect(page.node.Resources()).toBe(resources);
    expect(inspectRunPage(page)).toEqual(info);
    return;
  }
  expect(result).toMatchObject({ok:true,usedFallback:true,fallbackFaces:[face]});
  const saved=await PDFDocument.load(await doc.save()),out=saved.getPage(0),content=inspectRunPage(out);
  if(!content.ok)throw Error(content.reason);
  const shown=readRetypesetSource(out,tokenizeContentStream(content.bytes)).glyphs;
  expect(shown.map(g=>g.text).join('')).toBe('AéA');
  expect(shown[1]?.glyph.tjCompensation).toBe(advance!);
  expect(shown[2]?.x).toBeCloseTo(62,5);
});
for(const replacement of [
  editMatrix('like remind').find(e=>e.kind==='missing-glyph')!.text,
  editMatrix('like remind').find(e=>e.kind==='missing-glyph')!.text.normalize('NFD'),
  '漢éèüāŢ e', 'かなéèüāŢ e',
])test(`fallback page saves canonical accented text ${JSON.stringify(replacement)} and preserves source glyphs`,async()=>{
  const {doc,page,info,edit}=await fixture();
  const out=await replaceRunPageWithFallback(page,{sourceHash:info.sourceHash,edits:[{...edit,replacement:'A'+replacement}],allowOverflow:true},{loadFont});
  expect(out).toMatchObject({ok:true,usedFallback:true});
  const saved=await readSavedGlyphs(await doc.save({useObjectStreams:false}));
  expect(saved.glyphs.map(g=>g.unicode).join('')).toBe('A'+replacement.normalize('NFC')+'A');
  for(const glyph of [saved.glyphs[0]!,saved.glyphs.at(-1)!]){
    expect(glyph.fontObject).toBe(edit.fontObject);expect(glyph.code).toBe(65);
  }
});
test('NFD replacement reuses an already verified NFC source glyph',async()=>{
  const doc=await PDFDocument.create(),page=doc.addPage();
  const source=await prepareFallback(doc,'F1','LiberationSans-Regular.ttf',['é','e'],{loadFont});
  const encoded=source.resolved.canEncode!('e');if(!encoded.ok)throw Error(encoded.reason);
  page.node.set(PDFName.of('Resources'),doc.context.obj({Font:{F1:source.ref}}));
  page.node.set(PDFName.of('Contents'),doc.context.register(doc.context.stream(`BT /F1 12 Tf 50 100 Td <${Buffer.from(encoded.bytes).toString('hex')}> Tj ET`)));
  const info=inspectRunPage(page);if(!info.ok)throw Error(info.reason);let loads=0;
  const out=await replaceRunPageWithFallback(page,{sourceHash:info.sourceHash,allowOverflow:true,edits:[{
    fontResource:'F1',fontObject:source.ref.toString(),opIndex:3,itemIndex:-1,byteStart:0,byteEnd:2,expected:encoded.bytes,replacement:'e\u0301',
  }]},{loadFont:async name=>{loads++;return loadFont(name);}});
  expect(out.ok).toBe(true);expect(loads).toBe(0);
  const saved=await readSavedGlyphs(await doc.save({useObjectStreams:false}));
  expect(saved.glyphs.map(g=>g.unicode).join('')).toBe('é');
  expect(saved.glyphs[0]!.fontObject).toBe(source.ref.toString());
});
for (const [replacement,kind] of [['Aé','CIDFontType2'],['A漢','CIDFontType0']] as const) {
  test(`missing glyph ${replacement} uses searchable embedded subset and preserves source A`,async()=>{
    const {doc,page,info,edit}=await fixture();
    const duplicate=doc.addPage(); const resources=page.node.Resources()!, contents=page.node.get(PDFName.of('Contents'))!;
    duplicate.node.set(PDFName.of('Resources'),resources);duplicate.node.set(PDFName.of('Contents'),contents);
    const out=await replaceRunPageWithFallback(page,{sourceHash:info.sourceHash,edits:[{...edit,replacement}],allowOverflow:true},{loadFont});
    expect(out.ok).toBe(true);expect(duplicate.node.Resources()).toBe(resources);expect(duplicate.node.get(PDFName.of('Contents'))).toBe(contents);
    const fonts=page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict);
    expect(fonts.keys().length).toBe(2);
    const fb=fonts.entries().find(([name])=>name.decodeText()!=='F1')!;
    const font=doc.context.lookup(fb[1],PDFDict);
    expect(font.lookup(PDFName.of('Subtype'),PDFName).decodeText()).toBe('Type0');
    expect(font.lookup(PDFName.of('Encoding'),PDFName).decodeText()).toBe('Identity-H');
    expect(font.lookup(PDFName.of('ToUnicode'),PDFRawStream)).toBeDefined();
    const cid=font.lookup(PDFName.of('DescendantFonts'),PDFArray).lookup(0,PDFDict);
    expect(cid.lookup(PDFName.of('Subtype'),PDFName).decodeText()).toBe(kind);
    expect(cid.lookup(PDFName.of('W'),PDFArray).size()).toBeGreaterThan(0);
    const descriptor=cid.lookup(PDFName.of('FontDescriptor'),PDFDict);
    expect(descriptor.lookup(PDFName.of(kind==='CIDFontType2'?'FontFile2':'FontFile3'),PDFRawStream).getContents().length).toBeGreaterThan(0);
    if(kind==='CIDFontType2')expect(cid.lookup(PDFName.of('CIDToGIDMap'),PDFName).decodeText()).toBe('Identity');
    const saved=await readSavedGlyphs(await doc.save({useObjectStreams:false}));
    expect(saved.glyphs.map(g=>g.unicode).join('')).toBe(replacement+'A');
    expect(saved.glyphs[0]!.fontObject).toBe(edit.fontObject);expect(saved.glyphs[0]!.code).toBe(65);
  });
}
test('fsType restricted embedding refuses before changing any objects/resources/content',async()=>{
  const {doc,page,info,edit}=await fixture(); const count=doc.context.enumerateIndirectObjects().length;
  const resources=page.node.Resources(), contents=page.node.get(PDFName.of('Contents'));
  const original=tinyTtf(), v=new DataView(original.buffer,original.byteOffset,original.byteLength);
  const tables: Record<string,Uint8Array> = {};
  for(let i=0;i<v.getUint16(4);i++){const p=12+i*16;tables[new TextDecoder().decode(original.slice(p,p+4))]=original.slice(v.getUint32(p+8),v.getUint32(p+8)+v.getUint32(p+12));}
  tables['OS/2']=new Uint8Array(100); tables['OS/2'][9]=2;
  const restricted=sfnt(tables);
  const out=await replaceRunPageWithFallback(page,{sourceHash:info.sourceHash,edits:[edit]},{loadFont:async()=>restricted});
  expect(out.ok).toBe(false);if(!out.ok)expect(out.reason).toContain('embedding');
  expect(doc.context.enumerateIndirectObjects().length).toBe(count);expect(page.node.Resources()).toBe(resources);expect(page.node.get(PDFName.of('Contents'))).toBe(contents);
});
test('later invalid address and default overflow do not install a fallback',async()=>{
  for(const invalid of [false,true]){
    const {doc,page,info,edit}=await fixture();const count=doc.context.enumerateIndirectObjects().length;
    const out=await replaceRunPageWithFallback(page,{sourceHash:info.sourceHash,edits:invalid?[edit,{...edit,opIndex:99}]:[{...edit,replacement:'A漢漢漢'}]},{loadFont});
    expect(out.ok).toBe(false);expect(doc.context.enumerateIndirectObjects().length).toBe(count);
    expect(sourceGlyphs(doc,info.bytes,page.node.Resources()!,{}).map(g=>g.unicode).join('')).toBe('ABA');
  }
});

test('a concurrent page edit during font loading refuses the stale plan', async()=>{
  const {doc,page,info,edit}=await fixture();
  const changed=doc.context.register(doc.context.stream(b('BT /F1 12 Tf (BA) Tj ET')));
  let count=0;
  const out=await replaceRunPageWithFallback(page,{sourceHash:info.sourceHash,edits:[edit],allowOverflow:true},{loadFont:async name=>{
    page.node.set(PDFName.of('Contents'),changed);count=doc.context.enumerateIndirectObjects().length;return loadFont(name);
  }});
  expect(out.ok).toBe(false);if(!out.ok)expect(out.reason).toContain('page changed');
  expect(page.node.get(PDFName.of('Contents'))).toBe(changed);expect(doc.context.enumerateIndirectObjects().length).toBe(count);
});
test('an in-place resource change during font loading also invalidates the plan', async()=>{
  const {doc,page,info,edit}=await fixture();let count=0;
  const out=await replaceRunPageWithFallback(page,{sourceHash:info.sourceHash,edits:[edit],allowOverflow:true},{loadFont:async name=>{
    page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).set(PDFName.of('ShioriFb1'),doc.context.obj({Type:'Font'}));
    count=doc.context.enumerateIndirectObjects().length;return loadFont(name);
  }});
  expect(out.ok).toBe(false);if(!out.ok)expect(out.reason).toContain('page changed');
  expect(doc.context.enumerateIndirectObjects().length).toBe(count);
});

test('CID source font class comes from its descendant descriptor flags',async()=>{
  const {doc,page,edit}=await fixture();
  const font=page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict);
  const descriptor=font.lookup(PDFName.of('FontDescriptor'),PDFDict);descriptor.set(PDFName.of('Flags'),doc.context.obj(1));
  const map=new Uint8Array(134);map[131]=1;map[133]=2;
  const child=doc.context.register(doc.context.obj({Type:'Font',Subtype:'CIDFontType2',BaseFont:'UnknownFace',FontDescriptor:doc.context.register(descriptor),W:[65,[500,500]],CIDToGIDMap:doc.context.register(doc.context.flateStream(map))}));
  font.set(PDFName.of('Subtype'),PDFName.of('Type0'));font.set(PDFName.of('BaseFont'),PDFName.of('UnknownFace'));font.delete(PDFName.of('FontDescriptor'));
  font.set(PDFName.of('Encoding'),PDFName.of('Identity-H'));font.set(PDFName.of('DescendantFonts'),doc.context.obj([child]));
  font.set(PDFName.of('ToUnicode'),doc.context.register(doc.context.stream(b('2 beginbfchar <0041> <0041> <0042> <0042> endbfchar'))));
  page.node.set(PDFName.of('Contents'),doc.context.register(doc.context.stream(b('BT /F1 12 Tf 50 100 Td <00410042> Tj <0041> Tj ET'))));
  const info=inspectRunPage(page);if(!info.ok)throw Error(info.reason);let chosen='';
  const out=await replaceRunPageWithFallback(page,{sourceHash:info.sourceHash,edits:[{...edit,byteEnd:4,expected:Uint8Array.of(0,65,0,66)}],allowOverflow:true},{loadFont:async name=>{chosen=name;return loadFont(name);}});
  expect(out.ok).toBe(true);expect(chosen).toBe('LiberationMono-Regular.ttf');
});

test('fallback page adapter clamps an edit box before installing resources',async()=>{
  const {doc,page,info,edit}=await fixture();const count=doc.context.enumerateIndirectObjects().length;
  const out=await replaceRunPageWithFallback(page,{sourceHash:info.sourceHash,edits:[{...edit,editBox:{x:0,y:0,w:1,h:12}}]},{loadFont});
  expect(out.ok).toBe(false);expect(out.overflow?.availablePt).toBe(1);
  expect(doc.context.enumerateIndirectObjects().length).toBe(count);
});
test('indirect descriptor Flags chooses the source class',async()=>{
  const {doc,page,info,edit}=await fixture();
  const font=page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict);
  font.set(PDFName.of('BaseFont'),PDFName.of('UnknownFace'));
  font.lookup(PDFName.of('FontDescriptor'),PDFDict).set(PDFName.of('Flags'),doc.context.register(doc.context.obj(1)));
  let chosen='';const out=await replaceRunPageWithFallback(page,{sourceHash:info.sourceHash,edits:[edit],allowOverflow:true},{loadFont:async name=>{chosen=name;return loadFont(name);}});
  expect(out.ok).toBe(true);expect(chosen).toBe('LiberationMono-Regular.ttf');
});
test('CFF header offSize equals the emitted Name INDEX offSize',async()=>{
  const {doc,page,info,edit}=await fixture();
  const out=await replaceRunPageWithFallback(page,{sourceHash:info.sourceHash,edits:[{...edit,replacement:'漢'}],allowOverflow:true},{loadFont});expect(out.ok).toBe(true);
  const saved=await PDFDocument.load(await doc.save({useObjectStreams:false}));
  const fonts=saved.getPage(0).node.Resources()!.lookup(PDFName.of('Font'),PDFDict);
  const fb=fonts.entries().find(([name])=>name.decodeText().startsWith('ShioriFb'))!;
  const cid=saved.context.lookup(fb[1],PDFDict).lookup(PDFName.of('DescendantFonts'),PDFArray).lookup(0,PDFDict);
  const program=cid.lookup(PDFName.of('FontDescriptor'),PDFDict).lookup(PDFName.of('FontFile3'),PDFRawStream);
  const {decodePDFRawStream}=await import('pdf-lib');const bytes=decodePDFRawStream(program).decode();
  expect(bytes[3]).toBe(bytes[bytes[2]!+2]);expect(bytes[3]).toBeGreaterThanOrEqual(1);expect(bytes[3]).toBeLessThanOrEqual(4);
});

test('each edit draws the same missing Han scalar with its own marked-content language', async () => {
  for (const reverse of [false, true]) {
    const { doc, page, edit } = await fixture();
    const resources = page.node.Resources()!;
    resources.set(PDFName.of('Properties'), doc.context.obj({ Korean: { Lang: PDFString.of('ko') } }));
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(
      '/Span << /Lang (ja) >> BDC BT /F1 12 Tf 50 100 Td (AB) Tj ET EMC ' +
      '/Span /Korean BDC BT /F1 12 Tf 50 70 Td (AB) Tj ET EMC',
    )));
    const info = inspectRunPage(page);
    if (!info.ok) throw Error(info.reason);
    const edits = [4, 11].map(opIndex => ({ ...edit, opIndex, replacement: 'A骨' }));
    const out = await replaceRunPageWithFallback(page, {
      sourceHash: info.sourceHash, edits: reverse ? edits.toReversed() : edits, allowOverflow: true,
    }, { loadFont });
    expect(out).toMatchObject({ ok: true, usedFallback: true });
    const saved = await PDFDocument.load(await doc.save());
    const glyphs = paintedFontNames(saved);
    expect(glyphs).toEqual([
      'AAAAAA+Arial', await fallbackPdfName('NotoSansJP-Regular.otf'),
      'AAAAAA+Arial', await fallbackPdfName('NotoSansKR-Regular.otf'),
    ]);
  }
});

test('same-named local programs and bundled assets each draw their own glyph', async () => {
  const { doc, page, edit } = await fixture();
  const key = PDFName.of;
  const fonts = page.node.Resources()!.lookup(key('Font'), PDFDict);
  const font = fonts.lookup(key('F1'), PDFDict);
  const serif = font.clone(), mono = font.clone();
  serif.set(key('BaseFont'), key('ABCDEF+LiberationSerif'));
  mono.set(key('BaseFont'), key('ABCDEF+LiberationMono'));
  const serifRef = doc.context.register(serif), monoRef = doc.context.register(mono);
  fonts.set(key('F2'), serifRef);
  fonts.set(key('F3'), monoRef);
  page.node.set(key('Contents'), doc.context.register(doc.context.stream(
    'BT /F1 12 Tf 50 100 Td (AB) Tj ET BT /F2 12 Tf 50 70 Td (AB) Tj ET BT /F3 12 Tf 50 40 Td (AB) Tj ET',
  )));
  const info = inspectRunPage(page);
  if (!info.ok) throw Error(info.reason);
  const name = 'LiberationSans-Regular.ttf';
  const result = await replaceRunPageWithFallback(page, {
    sourceHash: info.sourceHash, allowOverflow: true, edits: [
      { ...edit, opIndex: 13, fontResource: 'F3', fontObject: monoRef.toString() },
      { ...edit, opIndex: 3 },
      { ...edit, opIndex: 8, fontResource: 'F2', fontObject: serifRef.toString() },
    ],
  }, { loadFont, localFonts: [
    { name, bytes: await loadFont('LiberationSerif-Regular.ttf') },
    { name, bytes: await loadFont('LiberationMono-Regular.ttf') },
  ] });
  expect(result).toMatchObject({ ok: true, usedFallback: true });
  const names = paintedFontNames(await PDFDocument.load(await doc.save()));
  expect(names[1]).toBe(await fallbackPdfName(name));
  expect(names[3]).toBe(await fallbackPdfName('LiberationSerif-Regular.ttf', 'LiberationSerif'));
  expect(names[5]).toBe(await fallbackPdfName('LiberationMono-Regular.ttf', 'LiberationMono'));
});

async function fallbackPdfName(asset: string, family = 'ShioriFallback') {
  const digest = sourceFingerprint(await loadFont(asset));
  return digest.slice(0, 6).replace(/[0-9a-f]/g, c => String.fromCharCode(65 + parseInt(c, 16))) + '+' + family;
}

function paintedFontNames(doc: PDFDocument) {
  const page = doc.getPage(0), info = inspectRunPage(page), resources = page.node.Resources()!;
  if (!info.ok) throw Error(info.reason);
  return sourceGlyphs(doc, info.bytes, resources, {}).map(glyph =>
    doc.context.lookup(PDFRef.of(Number(glyph.fontObject.split(' ')[0])), PDFDict).lookup(PDFName.of('BaseFont'), PDFName).decodeText());
}
