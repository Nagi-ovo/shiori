import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, PDFName } from 'pdf-lib';
import { prepareFallback, fallbackFontName } from './fallbackFont';
import { substituteFontName } from './substituteFonts';
import { editMatrix } from '../../../../scripts/pdf-corpus/editMatrix';
import { readSavedGlyphs } from '../../../../scripts/pdf-inplace/oracleGlyphs';
import { shapingFont } from './fallbackFont.test-support';

const clusters = (text: string) => [...new Set(
  [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(s => s.segment),
)];
const loadFont = (name: string) => readFile(name.startsWith('Noto')
  ? `src/assets/fonts/${name}` : `node_modules/@docx-editor.dev/fonts/assets/${name}`);

async function searchableSubset(name: string, text: string) {
  const source = await loadFont(name), copy = Buffer.from(source), doc = await PDFDocument.create();
  const prepared = await prepareFallback(doc, 'Fb', name, clusters(text), { loadFont: async () => source });
  const expected = text.normalize('NFC'), encoded = prepared.resolved.canEncode!(expected);
  expect(encoded.ok).toBe(true);
  if (!encoded.ok) throw Error(encoded.reason);
  const page = doc.addPage();
  page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { Fb: prepared.ref } }));
  const hex = Buffer.from(encoded.bytes).toString('hex');
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(`BT /Fb 12 Tf 50 100 Td <${hex}> Tj ET`)));
  const saved = await readSavedGlyphs(await doc.save({ useObjectStreams: false }));
  expect(saved.glyphs.map(g => g.unicode).join('')).toBe(expected);
  expect(saved.glyphs.every(g => g.glyphId !== undefined && g.glyphId > 0)).toBe(true);
  expect(source).toEqual(copy);
}

for (const name of ['LiberationSans', 'LiberationSerif', 'LiberationMono', 'Carlito']) {
  for (const form of ['NFC', 'NFD'] as const) test(`${name} compiles corpus missing-glyph clusters in ${form}`, async () => {
    const edit = editMatrix('like remind').find(e => e.kind === 'missing-glyph')!;
    expect(edit.text).toBe('éike remind');
    await searchableSubset(`${name}-Regular.ttf`, edit.text.normalize(form));
  });
}

// Every letter in Latin-1 Supplement and Extended-A, followed by base letters
// that composite outlines may have brought into fontkit's glyph cache.
const latin = Array.from({ length: 192 }, (_, i) => String.fromCodePoint(0xc0 + i)).join('') + ' eua';
for (const [label, base] of [
  ['sans', 'Arial'], ['serif', 'Times'], ['mono', 'Courier'],
  ['metric sans', 'Calibri'], ['metric serif', 'Cambria'], ['geometric sans', 'AvantGarde'],
] as const) {
  for (const flags of [0, 64, 1 << 18, 64 | (1 << 18)]) test(`${label} flags ${flags} substitutes the extended Latin range`, async () => {
    await searchableSubset(substituteFontName(base, flags, latin), latin);
  });
}
for (const text of ['漢éèüā e', 'かなéèüā e']) {
  for (const choose of [fallbackFontName, substituteFontName]) test(`${choose.name} keeps mixed ${text} searchable`, async () => {
    await searchableSubset(choose('Arial', 0, text), text);
  });
}

for (const text of ['q\u0301', '\u0301']) test(`refuses uncompiled combining mark in ${JSON.stringify(text)}`, async () => {
  const doc = await PDFDocument.create(), count = doc.context.enumerateIndirectObjects().length;
  await expect(prepareFallback(doc, 'Fb', 'LiberationSans-Regular.ttf', [text], { loadFont })).rejects.toThrow(/combining mark/);
  expect(doc.context.enumerateIndirectObjects().length).toBe(count);
});
test('refuses a missing cmap glyph instead of embedding .notdef', async () => {
  await expect(prepareFallback(await PDFDocument.create(), 'Fb', 'LiberationSans-Regular.ttf', ['\u{10ffff}'], { loadFont })).rejects.toThrow(/missing glyph/);
});
test('refuses a multi-scalar ligature even when fontkit makes one glyph', async () => {
  const name = 'Carlito-Regular.ttf', data = await loadFont(name);
  expect(fontkit.create(data).layout('fi').glyphs.length).toBe(1);
  await expect(prepareFallback(await PDFDocument.create(), 'Fb', name, ['fi'], { loadFont: async () => data })).rejects.toThrow(/shaping/);
});
test('refuses one-to-one GSUB even when its Unicode label matches', async () => {
  const data = shapingFont('substitution'), parsed = fontkit.create(data);
  expect(parsed.glyphForCodePoint(101).id).toBe(1);
  expect(parsed.layout('e').glyphs[0]!.id).toBe(2);
  await expect(prepareFallback(await PDFDocument.create(), 'Fb', 'fixture.ttf', ['e'], { loadFont: async () => data })).rejects.toThrow(/shaping/);
});
for (const field of [1, 2, 4, 8]) test(`refuses GPOS value field ${field}`, async () => {
  const data = shapingFont('position', field), parsed = fontkit.create(data), layout = parsed.layout('e');
  const p = layout.positions[0]!;
  expect(!!(p.xOffset || p.yOffset || p.yAdvance || p.xAdvance !== layout.glyphs[0]!.advanceWidth)).toBe(true);
  await expect(prepareFallback(await PDFDocument.create(), 'Fb', 'fixture.ttf', ['e'], { loadFont: async () => data })).rejects.toThrow(/shaping/);
});
