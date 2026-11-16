import {expect, test} from 'bun:test';
import {PDFDocument, PDFName} from 'pdf-lib';
import {fontCoverageFromDict} from '../fontCoverage/pdfLibAdapter';
import {tinyTtf} from '../fontCoverage/fixtures/programs';
import {inspectRunPage, replaceRunPage, resolveRunFonts} from './replaceRunPage';

async function fixture(options:{base?:string; subtype?:string; encoding?:string|null;
  differences?:Record<number, string>; embedded?:boolean; flags?:number; toUnicode?:string} = {}) {
  const doc = await PDFDocument.create(), ctx = doc.context, page = doc.addPage([300, 200]);
  const base = options.encoding === undefined ? 'WinAnsiEncoding' : options.encoding;
  const font = ctx.obj({Type:'Font', Subtype:options.subtype ?? 'TrueType', BaseFont:options.base ?? 'Arial',
    FirstChar:0, LastChar:255, Widths:Array(256).fill(500),
    ...(options.differences ? {Encoding:{...(base ? {BaseEncoding:base} : {}),
      Differences:Object.entries(options.differences).flatMap(([code, name]) => [+code, PDFName.of(name)])}}
      : base ? {Encoding:base} : {}),
    FontDescriptor:ctx.register(ctx.obj({Flags:options.flags ?? 32, Ascent:800, Descent:-200, FontBBox:[0, 0, 500, 800],
      ...(options.embedded ? {FontFile2:ctx.register(ctx.flateStream(tinyTtf({maps:[{platform:3, encoding:1,
        entries:[[65, 7], [32, 4]]}]})))} : {})})),
    ...(options.toUnicode === undefined ? {} : {ToUnicode:ctx.register(ctx.flateStream(options.toUnicode))})});
  const ref = ctx.register(font);
  page.node.set(PDFName.of('Resources'), ctx.obj({Font:{F1:ref}}));
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream('BT /F1 10 Tf 50 150 Td (AA) Tj ET')));
  const source = inspectRunPage(page); if (!source.ok) throw Error(source.reason);
  return {doc, page, font, ref, source, resolved:() => resolveRunFonts(page)[0]!};
}

for (const [base, subtype] of [['TimesNewRomanPSMT', 'TrueType'], ['Arial', 'TrueType'],
  ['Arial,Italic', 'TrueType'], ['TimesNewRomanPSMT', 'Type1']]) {
  test(`non-embedded ${subtype} ${base} has WinAnsi source labels without replacement authority`, async () => {
    const f = await fixture({base, subtype}), before = f.font.toString(), font = f.resolved();
    expect([65, 101, 32].map(code => font.unicodeByCode.get(code))).toEqual(['A', 'e', ' ']);
    expect(fontCoverageFromDict(f.font).verification).toBe('unverified');
    expect(font.canEncode!('A').ok).toBe(false);
    expect(() => font.assertSource!([Uint8Array.of(65)])).toThrow('requires a ToUnicode');
    expect(replaceRunPage(f.page, {sourceHash:f.source.sourceHash, allowExistingCodePermutation:true, edits:[{
      fontResource:'F1', fontObject:f.ref.toString(), opIndex:3, itemIndex:-1,
      byteStart:0, byteEnd:2, expected:Uint8Array.of(65, 65), replacement:'A',
    }]}).ok).toBe(false);
    expect(f.font.toString()).toBe(before);
    expect(inspectRunPage(f.page)).toEqual(f.source);
  });
}

test('non-embedded Differences prove named codes without assuming an unspecified base encoding', async () => {
  const f = await fixture({encoding:null, differences:{1:'A.alt', 2:'uni00E9', 3:'u1F600', 4:'unknownGlyph',
    5:'G41', 6:'C65', 7:'f_h', 8:'uniD800', 9:'uni0000'}}), font = f.resolved();
  expect([...font.unicodeByCode]).toEqual([[1, 'A'], [2, 'é'], [3, '😀']]);
  expect(font.canEncode!('A').ok).toBe(false);
});

for (const encoding of [null, 'UnpublishedEncoding']) test(`non-embedded font has no inferred identity with Encoding ${encoding}`, async () => {
  expect((await fixture({encoding})).resolved().unicodeByCode.size).toBe(0);
});

test('non-embedded symbolic fonts cannot infer identity from WinAnsi', async () => {
  expect((await fixture({flags:4})).resolved().unicodeByCode.size).toBe(0);
});

test('source-only labels fill holes and placeholders while preserving explicit ToUnicode', async () => {
  const f = await fixture({toUnicode:'2 beginbfchar <41> <0041> <65> <FFFD> endbfchar'}), font = f.resolved();
  expect([65, 101, 32].map(code => font.unicodeByCode.get(code))).toEqual(['A', 'e', ' ']);
  expect(font.canEncode!('A').ok).toBe(false); // Still no reusable program.
  expect(() => font.assertSource!([Uint8Array.of(101)])).toThrow('requires a ToUnicode');
  const conflict = (await fixture({toUnicode:'1 beginbfchar <41> <0065> endbfchar'})).resolved();
  expect(conflict.unicodeByCode.get(65)).toBe('e');
  expect(() => conflict.assertSource!([Uint8Array.of(65)])).toThrow('glyph-identity-conflict');
});

test('embedded subsets retain their outline presence proof for inferred labels', async () => {
  const font = (await fixture({embedded:true})).resolved();
  expect(font.unicodeByCode.get(65)).toBe('A');
  expect(font.unicodeByCode.get(66)).toBeUndefined(); // B selects .notdef.
  expect(font.canEncode!('A').ok).toBe(false);
  expect(() => font.assertSource!([Uint8Array.of(65)])).toThrow('requires a ToUnicode');
});

test('published Standard-14 built-in labels retain their existing coverage proof', async () => {
  const font = (await fixture({subtype:'Type1', base:'Helvetica', encoding:null})).resolved();
  expect(font.unicodeByCode.get(65)).toBe('A');
  expect(font.canEncode!('A').ok).toBe(false);
});
