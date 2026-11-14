import { expect, test } from 'bun:test';
import { PDFDocument, PDFName } from 'pdf-lib';
import { tinyTtf } from '../fontCoverage/fixtures/programs';
import { createFontCoverage } from '../fontCoverage/coverage';
import { inspectRunPage, replaceRunPage, resolveRunFonts } from './replaceRunPage';
import { replaceRuns, sourceFingerprint, type ResolvedRunFont } from './replaceRun';

const bytes = (s: string) => new TextEncoder().encode(s);
async function fixture(options: { empty?: number[]; raw?: boolean; program?: Uint8Array } = {}) {
  const doc = await PDFDocument.create(), ctx = doc.context, page = doc.addPage();
  const descriptor = ctx.register(ctx.obj({ Type: 'FontDescriptor', Flags: 32, Ascent: 800, Descent: -200,
    [options.raw ? 'FontFile' : 'FontFile2']: ctx.register(ctx.flateStream(options.raw ? bytes('%!PS fake Type1') : options.program ?? tinyTtf({
      maps: [{ platform: 3, encoding: 1, entries: [[65, 1], [66, 2], [67, 3], [100, 0]] }], empty: options.empty,
    }))) }));
  const font = ctx.obj({ Type: 'Font', Subtype: options.raw ? 'Type1' : 'TrueType', BaseFont: 'ABCDEF+Same',
    FirstChar: 32, Widths: Array(95).fill(500), Encoding: 'WinAnsiEncoding', FontDescriptor: descriptor,
    ToUnicode: ctx.register(ctx.flateStream('4 beginbfchar <41> <0041> <42> <0042> <43> <0043> <64> <0064> endbfchar')) });
  const f1 = ctx.register(font), other = font.clone(ctx);
  other.set(PDFName.of('Encoding'), ctx.obj({ BaseEncoding: 'WinAnsiEncoding', Differences: [67, 'd'] }));
  const f2 = ctx.register(other);
  page.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: f1, Alias: f1, F2: f2 } }));
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream('BT /F1 10 Tf (AB) Tj (d) Tj /F2 10 Tf (AB) Tj ET')));
  const source = inspectRunPage(page);
  if (!source.ok) throw Error(source.reason);
  const edit = { fontResource: 'F1', fontObject: f1.toString(), opIndex: 2, itemIndex: -1,
    byteStart: 0, byteEnd: 2, expected: bytes('AB'), replacement: 'C' };
  return { doc, ctx, page, source, edit, f1, f2 };
}
test('program-backed unshown glyph succeeds; same-BaseFont subset and aliases keep identity', async () => {
  const { page, source, edit, f2 } = await fixture();
  const fonts = resolveRunFonts(page);
  expect(fonts.find(f => f.resourceName === 'F1')?.canEncode).toBe(fonts.find(f => f.resourceName === 'Alias')?.canEncode);
  const inherited = page.node.Resources()!;
  page.node.Parent()!.set(PDFName.of('Resources'), inherited);
  page.node.delete(PDFName.of('Resources'));
  expect(replaceRunPage(page, { sourceHash: source.sourceHash, edits: [{ ...edit, fontResource: 'F2', fontObject: f2.toString(), opIndex: 5 }] })).toMatchObject({ ok: false, firstMissing: 'C', offset: 0 });
  expect(replaceRunPage(page, { sourceHash: source.sourceHash, edits: [{ ...edit, fontResource: 'Alias' }] })).toMatchObject({ ok: false }); // stale show font
  expect(replaceRunPage(page, { sourceHash: source.sourceHash, edits: [edit] }).ok).toBe(true);
});
for (const options of [{}, { empty: [3] }, { raw: true }, { program: Uint8Array.of(0, 1, 0, 0) }]) {
  test(`coverage failure reports exact missing cluster and preserves all bytes: ${JSON.stringify(options)}`, async () => {
    const { doc, ctx, page, source, edit } = await fixture(options);
    const replacement = 'raw' in options || 'program' in options ? 'AB' : 'empty' in options ? 'ABC' : 'ABd';
    const original = page.node.get(PDFName.of('Contents')), count = ctx.enumerateIndirectObjects().length;
    const before = await doc.save({ useObjectStreams: false });
    const result = replaceRunPage(page, { sourceHash: source.sourceHash, edits: [{ ...edit, replacement }] });
    expect(result).toMatchObject({ ok: false, firstMissing: replacement.at(-1) === 'd' ? 'd' : replacement === 'ABC' ? 'C' : 'A', offset: replacement.length === 3 ? 2 : 0 });
    if (!result.ok) expect(result.reason).toMatch(/notdef|glyf|Type1|font program/);
    expect(page.node.get(PDFName.of('Contents'))).toBe(original);
    expect(ctx.enumerateIndirectObjects().length).toBe(count);
    expect(await doc.save({ useObjectStreams: false })).toEqual(before);
  });
}
test('unverified font refuses deletion', async () => {
  const { page, source, edit } = await fixture({ raw: true });
  expect(replaceRunPage(page, { sourceHash: source.sourceHash, edits: [{ ...edit, replacement: '' }] })).toMatchObject({ ok: false });
});

function pureFont(mapping: string, differences: Record<number, string> = {}): ResolvedRunFont {
  const coverage = createFontCoverage({ subtype: 'Type1', baseFont: 'Helvetica', encoding: { base: 'WinAnsiEncoding', differences }, toUnicode: mapping });
  return { resourceName: 'F1', objectId: '7 0 R', bytesPerCode: 1, widthOf: c => c === 1 ? 300 : 500,
    ascentEm: .8, descentEm: -.2, unicodeByCode: new Map([...coverage.codeToUnicode].map(([h, s]) => [parseInt(h, 16), s])), canEncode: coverage.canEncode };
}
function compile(f: ResolvedRunFont, sourceCode: number, replacement: string) {
  const content = bytes(`BT /F1 10 Tf <${sourceCode.toString(16).padStart(2, '0')}> Tj (A) Tj ET`);
  return { content, result: replaceRuns(content, [f], { sourceHash: sourceFingerprint(content), edits: [{ fontResource: 'F1', fontObject: '7 0 R',
    opIndex: 2, itemIndex: -1, byteStart: 0, byteEnd: 1, expected: Uint8Array.of(sourceCode), replacement }] }) };
}
for (const reverse of [false, true]) test(`duplicate codes prefer original then sorted default (reverse=${reverse})`, () => {
  const rows = ['<01> <0041>', '<02> <0041>', '<42> <0042>'];
  const f = pureFont(`3 beginbfchar ${reverse ? rows.reverse().join(' ') : rows.join(' ')} endbfchar`, { 1: 'A', 2: 'A' });
  expect(compile(f, 2, 'A').result).toMatchObject({ ok: true, bytes: compile(f, 2, 'A').content });
  const fallback = compile(f, 66, 'A').result;
  expect(fallback.ok).toBe(true);
  expect(new TextDecoder().decode(fallback.bytes)).toContain('<01>');
});
test('ligature emits one code and compensates its width rather than Unicode length', () => {
  const f = pureFont('2 beginbfchar <01> <00660069> <41> <0041> endbfchar', { 1: 'fi' });
  const result = compile(f, 65, 'fi').result;
  expect(result.ok).toBe(true);
  expect(new TextDecoder().decode(result.bytes)).toContain('[<01> -200] TJ (A) Tj');
});
test('supplementary failure offset is UTF-16 and missing coverage refuses', () => {
  const f = pureFont('2 beginbfchar <01> <d83dde00> <41> <0041> endbfchar', { 1: 'A' });
  const { result, content } = compile(f, 65, '😀Ad');
  expect(result).toMatchObject({ ok: false, firstMissing: 'd', offset: 3 });
  expect(result.bytes).toBe(content);
  const noCoverage = { ...f, canEncode: undefined };
  expect(compile(noCoverage, 65, 'A').result.ok).toBe(false);
});
