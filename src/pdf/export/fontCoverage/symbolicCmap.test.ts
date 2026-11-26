import { expect, test } from 'bun:test';
import { createFontCoverage } from './coverage';
import { format4Points, sfnt } from './fixtures/programs';
import { namedTtf, ttfTables } from './symbolicCmap.test-support';
import { PDFDocument, PDFName } from 'pdf-lib';
import { resolveRunFonts, inspectRunPage } from '../contentStreamEdit/replaceRunPage';
import { planContentText } from '../contentText/planner';
import { replaceRuns } from '../contentStreamEdit/replaceRun';
import { overlay } from '../contentText/fixtures.test-support';

// Failure inventory: aliases, zero vs holes, duplicate records, no Mac fallback
// through a present symbol hole, invalid table bounds/ranges/offsets, missing
// glyf/loca, out-of-range GID, name/label disagreement, and actual run encoding.
const unicode = '2 beginbfchar <41> <0041> <53> <0053> endbfchar';
const map = (entries: [number, number][]) => ({ platform: 3, encoding: 0, entries: [], subtable: format4Points(entries) });
const coverage = (maps: NonNullable<Parameters<typeof namedTtf>[0]>['maps'], extra = {}) => createFontCoverage({
  subtype: 'TrueType', flags: 4, program: namedTtf({ maps }), toUnicode: unicode, ...extra,
});
for (const high of [0, 0xf000, 0xf100, 0xf200]) test(`uniquely mapped symbolic base ${high} encodes the existing byte`, () => {
  expect(coverage([map([[high + 65, 7]])]).canEncode('A')).toMatchObject({ ok: true, bytes: Uint8Array.of(65) });
});
test('all unmapped is unsupported, while explicit zero alone is ambiguous', () => {
  expect(coverage([map([[83, 1]])]).canEncode('A')).toMatchObject({ ok: false, reason: expect.stringContaining('symbolic-cmap-unsupported') });
  expect(coverage([map([[65, 0]])]).canEncode('A')).toMatchObject({ ok: false, reason: expect.stringContaining('symbolic-cmap-ambiguous') });
});
test('duplicate symbol records refuse even if the bytes agree', () => {
  expect(coverage([map([[65, 7]]), map([[65, 7]])]).canEncode('A')).toMatchObject({ ok: false, reason: expect.stringContaining('symbolic-cmap-ambiguous') });
});
test('present symbol hole cannot select a Mac glyph', () => {
  expect(coverage([map([[83, 1]]), { platform: 1, encoding: 0, entries: [[65, 7]] }]).canEncode('A')).toMatchObject({ ok: false, reason: expect.stringContaining('symbolic-cmap-unsupported') });
});
test('symbolic replacements require both an actual glyph name and an agreeing ToUnicode label', () => {
  const maps = [map([[65, 7]])];
  const diagnostic = coverage(maps, { toUnicode: undefined });
  expect(diagnostic.codeToUnicode.get('41')).toBe('A');
  expect(diagnostic.canEncode('A')).toMatchObject({ ok: false, reason: expect.stringContaining('missing-tounicode') });
  expect(coverage(maps, { toUnicode: '1 beginbfchar <41> <0042> endbfchar' }).canEncode('B'))
    .toMatchObject({ ok: false, reason: expect.stringContaining('glyph-identity-conflict') });
});
for (const absent of ['glyf', 'loca']) test(`missing ${absent} stays refused`, () => {
  const tables = ttfTables(namedTtf({ maps: [map([[65, 7]])] })); delete tables[absent];
  expect(createFontCoverage({ subtype: 'TrueType', flags: 4, program: sfnt(tables), toUnicode: unicode }).canEncode('A').ok).toBe(false);
});
test('out-of-range selected GID stays refused', () => {
  expect(coverage([map([[65, 20]])]).canEncode('A')).toMatchObject({ ok: false, reason: expect.stringContaining('GID outside') });
});
for (const mutate of [
  (t: Uint8Array) => new DataView(t.buffer).setUint16(14, 10), // declared subtable shorter than its arrays
  (t: Uint8Array) => new DataView(t.buffer).setUint32(8, t.length + 10), // bad record offset
  (t: Uint8Array) => new DataView(t.buffer).setUint16(40, 0xffff), // odd idRangeOffset
]) test('malformed symbolic cmap does not claim coverage', () => {
  const tables = ttfTables(namedTtf({ maps: [map([[65, 7]])] })); mutate(tables.cmap!);
  expect(createFontCoverage({ subtype: 'TrueType', flags: 4, program: sfnt(tables), toUnicode: unicode }).canEncode('A').ok).toBe(false);
});
test('symbolic format 2 remains a precise unsupported format', () => {
  const subtable = new Uint8Array(526), v = new DataView(subtable.buffer); v.setUint16(0, 2); v.setUint16(2, subtable.length);
  expect(coverage([{ platform: 3, encoding: 0, entries: [], subtable }]).canEncode('A'))
    .toMatchObject({ ok: false, reason: expect.stringContaining('tt-cmap-format-unsupported') });
});
test('unique symbolic selection reaches the page resolver, planner and compiler', async () => {
  const doc = await PDFDocument.create(), ctx = doc.context, page = doc.addPage([300, 200]);
  const font = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'TrueType', FirstChar: 65, LastChar: 83,
    Widths: Array(19).fill(600), ToUnicode: ctx.register(ctx.flateStream(unicode)),
    FontDescriptor: ctx.obj({ Flags: 4, FontFile2: ctx.register(ctx.flateStream(namedTtf({ maps: [map([[0xf041, 7], [0xf053, 1]])] }))) }) }));
  page.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: font } }));
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream('BT /F1 10 Tf 50 100 Td (A) Tj ET')));
  const source = inspectRunPage(page); expect(source.ok).toBe(true); if (!source.ok) return;
  const fonts = resolveRunFonts(page), planned = planContentText(source.bytes, fonts, overlay({ originalText: 'A', text: 'S', coverRects: [{ x: 49, y: 98, w: 8, h: 13 }] }));
  expect(planned.ok).toBe(true); if (!planned.ok) return;
  const out = replaceRuns(source.bytes, fonts, planned.plan);
  expect(out.ok).toBe(true); expect(new TextDecoder().decode(out.bytes)).toContain('<53>');
});
