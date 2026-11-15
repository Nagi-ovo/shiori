import {expect, test} from 'bun:test';
import {PDFDocument, PDFName} from 'pdf-lib';
import {tinyTtf} from '../fontCoverage/fixtures/programs';
import {nums, widthChar} from '../fontCoverage/fixtures/type1';
import {applyContentTextEdits} from '../contentText/apply';
import {overlay} from '../contentText/fixtures.test-support';
import {type1Fixture} from '../contentText/type1Wiring.test-support';
import {inspectRunPage, resolveRunFonts} from './replaceRunPage';

const ligatures = [['ff', 'ﬀ'], ['fi', 'ﬁ'], ['fl', 'ﬂ'], ['ffi', 'ﬃ'], ['ffl', 'ﬄ']] as const;
const utf16 = (s:string) => Array.from(s, c => c.charCodeAt(0).toString(16).padStart(4, '0')).join('');

async function fixture(name:string, glyph:string, explicit:string|undefined, cid = false, ambiguous = false) {
  const doc = await PDFDocument.create(), ctx = doc.context, page = doc.addPage([300, 200]);
  const entries:[number, number][] = [[glyph.codePointAt(0)!, 7]];
  if (ambiguous) entries.push([0xfb01, 7]);
  const descriptor = ctx.register(ctx.obj({Flags:32, Ascent:800, Descent:-200, FontBBox:[0, 0, 500, 800],
    FontFile2:ctx.register(ctx.flateStream(tinyTtf({maps:[{platform:3, encoding:1, entries}]})))}));
  const hex = cid ? '0007' : '41';
  const font = ctx.obj({Type:'Font', Subtype:cid ? 'Type0' : 'TrueType', BaseFont:'Tiny',
    ...(cid ? {Encoding:'Identity-H', DescendantFonts:[ctx.register(ctx.obj({Type:'Font',
      Subtype:'CIDFontType2', DW:500, CIDToGIDMap:'Identity', FontDescriptor:descriptor}))]} : {
      FirstChar:65, LastChar:65, Widths:[500], FontDescriptor:descriptor,
      Encoding:{Differences:[65, PDFName.of(name)]}}),
    ...(explicit === undefined ? {} : {ToUnicode:ctx.register(ctx.flateStream(
      `1 beginbfchar <${hex}> <${utf16(explicit)}> endbfchar`))})});
  page.node.set(PDFName.of('Resources'), ctx.obj({Font:{F1:ctx.register(font)}}));
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(
    `BT /F1 10 Tf 50 100 Td <${hex}${hex}> Tj ET`)));
  return {page, code:cid ? Uint8Array.of(0, 7) : Uint8Array.of(65), number:cid ? 7 : 65};
}

for (const [ascii, glyph] of ligatures) {
  test(`ToUnicode ${ascii} agrees with AGL ${glyph} and keeps its explicit label`, async () => {
    const f = await fixture(ascii, glyph, ascii), font = resolveRunFonts(f.page)[0]!;
    expect(font.unicodeByCode.get(f.number)).toBe(ascii);
    expect(() => font.assertSource!([f.code])).not.toThrow();
    expect(font.canEncode!(ascii)).toMatchObject({ok:true, bytes:f.code});
  });

  test(`shortening a line with ToUnicode ${ascii} and AGL ${glyph} stays in-place`, async () => {
    const f = await fixture(ascii, glyph, ascii);
    const result = await applyContentTextEdits(f.page, [overlay({originalText:ascii + ascii, text:ascii,
      rect:{x:49, y:98, w:12, h:13}, coverRects:[{x:49, y:98, w:12, h:13}]})], {stage5Substitute:false});
    expect(result.outcomes).toEqual([{overlayId:'edit', mode:'in-place'}]);
    expect(result.remaining).toEqual([]);
    const source = inspectRunPage(f.page);
    expect(source.ok).toBe(true);
    if (!source.ok) throw Error(source.reason);
    expect(new TextDecoder().decode(source.bytes)).toContain('<41>');
  });

  test(`Type1 source proof accepts ToUnicode ${ascii} for /${ascii} and preserves in-place editing`, async () => {
    const outline = Uint8Array.from([...nums(0, 600), 13, ...nums(0, 0), 21, ...nums(400, 0), 5,
      ...nums(0, 700), 5, ...nums(-400, 0), 5, 9, 14]);
    const f = await type1Fixture({stream:'BT /F1 10 Tf 50 100 Td (AA) Tj ET', differences:[65, ascii],
      programOptions:{glyphs:{'.notdef':widthChar(0), [ascii]:outline}}});
    f.font.set(PDFName.of('ToUnicode'), f.doc.context.register(f.doc.context.flateStream(
      `1 beginbfchar <41> <${utf16(ascii)}> endbfchar`)));
    const font = resolveRunFonts(f.page)[0]!;
    expect(font.unicodeByCode.get(65)).toBe(ascii);
    expect(() => font.assertSource!([Uint8Array.of(65)])).not.toThrow();
    expect(font.canEncode!(ascii)).toMatchObject({ok:true, bytes:Uint8Array.of(65)});
    const result = await applyContentTextEdits(f.page, [overlay({originalText:ascii + ascii, text:ascii,
      coverRects:[{x:49, y:98, w:14, h:13}]})], {stage5Substitute:false});
    expect(result.outcomes).toEqual([{overlayId:'edit', mode:'in-place'}]);
    expect(result.remaining).toEqual([]);
  });
}

test('CID cmap ligature and expanded ToUnicode have the same source identity', async () => {
  const f = await fixture('ff', 'ﬀ', 'ff', true), font = resolveRunFonts(f.page)[0]!;
  expect(font.unicodeByCode.get(f.number)).toBe('ff');
  expect(() => font.assertSource!([f.code])).not.toThrow();
  expect(font.canEncode!('ff')).toMatchObject({ok:true, bytes:f.code});
});

test('ambiguous CID cmap ligatures still conflict with explicit ToUnicode', async () => {
  const f = await fixture('ff', 'ﬀ', 'ff', true, true), font = resolveRunFonts(f.page)[0]!;
  expect(() => font.assertSource!([f.code])).toThrow('glyph-identity-conflict');
});

test('different ligatures and unrelated compatibility characters still conflict', async () => {
  for (const [name, glyph, explicit] of [['ff', 'ﬀ', 'fi'], ['A', 'A', 'Ａ']] as const) {
    const f = await fixture(name, glyph, explicit), font = resolveRunFonts(f.page)[0]!;
    expect(() => font.assertSource!([f.code])).toThrow('glyph-identity-conflict');
  }
});

test('recovered ligature labels still need explicit ToUnicode to authorize edits', async () => {
  const f = await fixture('ff', 'ﬀ', undefined), font = resolveRunFonts(f.page)[0]!;
  expect(font.unicodeByCode.get(f.number)).toBe('ﬀ');
  expect(() => font.assertSource!([f.code])).toThrow('requires a ToUnicode');
  expect(font.canEncode!('ﬀ')).toMatchObject({ok:false});
});
