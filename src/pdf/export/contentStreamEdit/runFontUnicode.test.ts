import {expect, test} from 'bun:test';
import {PDFDict, PDFDocument, PDFName} from 'pdf-lib';
import {tinyTtf} from '../fontCoverage/fixtures/programs';
import {namedTtf} from '../fontCoverage/symbolicCmap.test-support';
import {inspectRunPage, replaceRunPage, resolveRunFonts} from './replaceRunPage';
import {streamReflowEvidence} from '../contentText/reflowEvidence';
import {planStreamReflow} from '../contentText/reflowAuto';
import {overlay} from '../contentText/fixtures.test-support';
import {type1Fixture} from '../contentText/type1Wiring.test-support';

async function fixture(toUnicode?: string, differences?: Record<number, string>) {
  const doc = await PDFDocument.create(), ctx = doc.context, page = doc.addPage([300, 200]);
  const font = ctx.obj({Type:'Font', Subtype:'TrueType', BaseFont:'Tiny', FirstChar:0, LastChar:255,
    Widths:Array(256).fill(500), Encoding:differences ? {BaseEncoding:'WinAnsiEncoding',
      Differences:Object.entries(differences).flatMap(([code, name]) => [+code, PDFName.of(name)])} : 'WinAnsiEncoding',
    FontDescriptor:ctx.register(ctx.obj({Flags:32, Ascent:800, Descent:-200, FontBBox:[0, 0, 500, 800],
      FontFile2:ctx.register(ctx.flateStream(tinyTtf({maps:[{platform:3, encoding:1,
        entries:[[65, 7], [101, 2], [32, 4]]}]})))})),
    ...(toUnicode === undefined ? {} : {ToUnicode:ctx.register(ctx.flateStream(toUnicode))})});
  const ref = ctx.register(font);
  page.node.set(PDFName.of('Resources'), ctx.obj({Font:{F1:ref}}));
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(
    '/P <</MCID 0>> BDC BT /F1 10 Tf 14 TL 50 150 Td (Ae Ae) Tj ET EMC')));
  const source = inspectRunPage(page); if (!source.ok) throw Error(source.reason);
  return {doc, page, font, ref, source};
}

for (const toUnicode of [undefined, '', '1 beginbfchar <41> <0041> endbfchar',
  '3 beginbfchar <41> <FFFD> <65> <FFFD> <20> <FFFD> endbfchar']) {
  test(`recovers same-BT tagged line labels with ToUnicode ${JSON.stringify(toUnicode)}`, async () => {
    const f = await fixture(toUnicode), before = f.font.toString();
    const fonts = resolveRunFonts(f.page), font = fonts[0]!;
    expect([65, 101, 32].map(code => font.unicodeByCode.get(code))).toEqual(['A', 'e', ' ']);
    const evidence = streamReflowEvidence(f.page, f.source.bytes, fonts, 5);
    expect(evidence?.lines.map(line => line.shows.map(show => show.unicode).join(''))).toEqual(['Ae Ae']);
    expect(evidence?.source.map(glyph => [...glyph.code])).toEqual([[65], [101], [32], [65], [101]]);
    expect(f.font.toString()).toBe(before);
    expect(inspectRunPage(f.page)).toEqual(f.source);
  });
}

test('uses Encoding Differences and AGL without assuming source code is Unicode', async () => {
  const f = await fixture('1 beginbfchar <01> <FFFD> endbfchar', {1:'A.alt', 2:'uni0065', 3:'space', 4:'unknownGlyph'});
  const font = resolveRunFonts(f.page)[0]!;
  expect([1, 2, 3, 4].map(code => font.unicodeByCode.get(code))).toEqual(['A', 'e', ' ', undefined]);
});

test('uses actual symbolic cmap/post names instead of PDF Encoding guesses', async () => {
  const f = await fixture();
  const descriptor = f.font.lookup(PDFName.of('FontDescriptor'), PDFDict);
  descriptor.set(PDFName.of('Flags'), f.doc.context.obj(4));
  descriptor.set(PDFName.of('FontFile2'), f.doc.context.register(f.doc.context.flateStream(
    namedTtf({maps:[{platform:3, encoding:0, entries:[[0xf041, 7]]}]}))));
  const font = resolveRunFonts(f.page)[0]!;
  expect(font.unicodeByCode.get(65)).toBe('A');
  expect(font.unicodeByCode.get(101)).toBeUndefined();
});

test('unproved replacement characters stay unknown', async () => {
  const f = await fixture('2 beginbfchar <42> <FFFD> <04> <FFFD> endbfchar', {4:'unknownGlyph'});
  const font = resolveRunFonts(f.page)[0]!;
  expect(font.unicodeByCode.has(66)).toBe(false); // B selects .notdef in this subset.
  expect(font.unicodeByCode.has(4)).toBe(false);
});

test('malformed ToUnicode never grants name-based edit authority', async () => {
  const f = await fixture('2 beginbfchar <41> <0041> endbfchar');
  expect(resolveRunFonts(f.page)[0]!.unicodeByCode.size).toBe(0);
});

test('Type0 labels follow CIDToGIDMap and the program cmap, never CID values', async () => {
  const f = await fixture(), ctx = f.doc.context;
  const map = new Uint8Array(86);
  map[3] = 7; map[5] = 2; map[85] = 4; // CID1=A, CID2=e, CID42=space.
  const child = ctx.register(ctx.obj({Type:'Font', Subtype:'CIDFontType2', DW:500,
    FontDescriptor:f.font.get(PDFName.of('FontDescriptor')), CIDToGIDMap:ctx.register(ctx.flateStream(map))}));
  f.font.set(PDFName.of('Subtype'), PDFName.of('Type0'));
  f.font.set(PDFName.of('Encoding'), PDFName.of('Identity-H'));
  f.font.set(PDFName.of('DescendantFonts'), ctx.obj([child]));
  const font = resolveRunFonts(f.page)[0]!;
  expect([1, 2, 42, 65].map(code => font.unicodeByCode.get(code))).toEqual(['A', 'e', ' ', undefined]);
});

for (const replacement of ['', 'eA']) test(`simple-font identity conflicts refuse ${JSON.stringify(replacement)}`, async () => {
  const f = await fixture('2 beginbfchar <41> <0065> <65> <0041> endbfchar');
  expect(replaceRunPage(f.page, {sourceHash:f.source.sourceHash, allowExistingCodePermutation:true, edits:[{
    fontResource:'F1', fontObject:f.ref.toString(), opIndex:5, itemIndex:-1,
    byteStart:0, byteEnd:2, expected:Uint8Array.of(65, 101), replacement,
  }]})).toMatchObject({ok:false, terminal:true, reason:expect.stringContaining('glyph-identity-conflict')});
});

test('a conflicting replacement code cannot be introduced from a good source code', async () => {
  const f = await fixture('3 beginbfchar <41> <0065> <65> <0065> <20> <0020> endbfchar');
  expect(replaceRunPage(f.page, {sourceHash:f.source.sourceHash, edits:[{
    fontResource:'F1', fontObject:f.ref.toString(), opIndex:5, itemIndex:-1,
    byteStart:2, byteEnd:3, expected:Uint8Array.of(32), replacement:'e',
  }]})).toMatchObject({ok:false, terminal:true, reason:expect.stringContaining('glyph-identity-conflict')});
});

test('recovered labels do not authorize new replacement text or code permutations without ToUnicode', async () => {
  const f = await fixture();
  for (const replacement of ['eA', 'e']) {
    expect(replaceRunPage(f.page, {sourceHash:f.source.sourceHash, allowExistingCodePermutation:true, edits:[{
      fontResource:'F1', fontObject:f.ref.toString(), opIndex:5, itemIndex:-1,
      byteStart:0, byteEnd:2, expected:Uint8Array.of(65, 101), replacement,
    }]}).ok).toBe(false);
  }
});

for (const replacement of ['', 'BA']) test(`present Type1 identity conflicts still refuse ${JSON.stringify(replacement)}`, async () => {
  const f = await type1Fixture({differences:[65, 'B', 'A']});
  expect(replaceRunPage(f.page, f.plan(replacement))).toMatchObject({ok:false, terminal:true,
    reason:expect.stringContaining('glyph-identity-conflict')});
  expect(inspectRunPage(f.page)).toEqual(f.source);
});

test('a recovered code cannot hide a later Type1 metrics conflict', async () => {
  const f = await type1Fixture({widths:[600, 602, 600]}), ctx = f.doc.context;
  f.font.set(PDFName.of('ToUnicode'), ctx.register(ctx.flateStream(
    '3 beginbfchar <41> <FFFD> <42> <0042> <43> <0043> endbfchar')));
  expect(replaceRunPage(f.page, f.plan(''))).toMatchObject({ok:false, terminal:true,
    reason:expect.stringContaining('font-metrics-conflict')});
});

test('overflow planning sees recovered source labels with a searchable substitute', async () => {
  const f = await fixture(), ctx = f.doc.context;
  const replacement = f.font.clone(ctx);
  replacement.set(PDFName.of('ToUnicode'), ctx.register(ctx.flateStream(
    '3 beginbfchar <41> <0041> <65> <0065> <20> <0020> endbfchar')));
  f.page.node.Resources()!.lookup(PDFName.of('Font'), PDFDict).set(PDFName.of('F2'), ctx.register(replacement));
  const fonts = resolveRunFonts(f.page);
  const plan = planStreamReflow(f.page, f.source.bytes, fonts,
    overlay({originalText:'A', text:'Ae Ae', coverRects:[{x:49.9, y:148, w:5.2, h:12}]}), {}, {}, fonts[1]!);
  expect(plan?.reflow?.layout.strategy).toBe('wrap');
  expect(plan?.reflow?.clusters.map(glyph => glyph.unicode).join('')).toBe('Ae Aee Ae');
  expect(plan?.reflow?.clusters.filter(glyph => glyph.source).map(glyph => [...glyph.code]))
    .toEqual([[101], [32], [65], [101]]);
});
