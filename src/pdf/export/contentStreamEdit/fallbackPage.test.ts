import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFDict, PDFName, PDFArray, PDFRawStream } from 'pdf-lib';
import { inspectRunPage } from './replaceRunPage';
import { replaceRunPageWithFallback } from './fallbackPage';
import { tinyTtf, sfnt } from '../fontCoverage/fixtures/programs';
import { sourceGlyphs, readSavedGlyphs } from '../../../../scripts/pdf-inplace/oracleGlyphs';
const b = (s: string) => new TextEncoder().encode(s);
const loadFont = (name: string) => readFile(name.endsWith('.ttf') ? `node_modules/@docx-editor.dev/fonts/assets/${name}` : `src/assets/fonts/${name}`);
async function fixture() {
  const doc = await PDFDocument.create(), page = doc.addPage();
  const f = doc.context.register(doc.context.obj({ Type:'Font',Subtype:'TrueType',BaseFont:'AAAAAA+Arial',FirstChar:65,Widths:[500,500],Encoding:'WinAnsiEncoding',
    FontDescriptor:doc.context.register(doc.context.obj({Flags:32,FontFile2:doc.context.register(doc.context.flateStream(tinyTtf({maps:[{platform:3,encoding:1,entries:[[65,1],[66,2]]}]})))})),
    ToUnicode:doc.context.register(doc.context.stream(b('2 beginbfchar <41> <0041> <42> <0042> endbfchar'))) }));
  page.node.set(PDFName.of('Resources'),doc.context.obj({Font:{F1:f}}));
  page.node.set(PDFName.of('Contents'),doc.context.register(doc.context.stream(b('BT /F1 12 Tf 50 100 Td (AB) Tj (A) Tj ET'))));
  const info=inspectRunPage(page); if(!info.ok)throw Error(info.reason);
  const edit={fontResource:'F1',fontObject:f.toString(),opIndex:3,itemIndex:-1,byteStart:0,byteEnd:2,expected:b('AB'),replacement:'Aé'};
  return {doc,page,info,edit};
}
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
