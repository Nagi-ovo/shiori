import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import fontkit from '@pdf-lib/fontkit';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { openPdfium } from '../../../../scripts/pdf-inplace/nativePdfium';
import { exportPdf } from '../exportPdf';
import { overlay } from './fixtures.test-support';
import { matrixCff } from './reflowRegion.test-support';

const library = 'vendor/pdfium/linux-x64/lib/libpdfium.so';
const size = 18.4164, x0 = 65, y0 = 220;
const nativeTest = test.skipIf(!existsSync(library));
type Encode = (text: string) => string;

/** A list-like page whose 18.4 pt title is tracked at `tracking` Tc.
 * `title` writes the show; `extra` adds page content in /F1 (embedded) or
 * in fonts without an embedded program, so readers substitute their own:
 * /F2 declares no bounding box (its ink has no bound at all), /F3 declares
 * an ordinary FontBBox, /F4 a FontBBox reaching four em below the baseline.
 * /F5 embeds a CFF program whose A is an empty path the parser reports
 * without proving it empty, the way a dropped path would look. */
async function fixture(title: (e: Encode) => string, extra: (e: Encode) => string[] = () => [], tracking = .18) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(readFileSync('node_modules/@docx-editor.dev/fonts/assets/LiberationSans-Regular.ttf'));
  const page = doc.addPage([400, 300]), ctx = doc.context, name = PDFName.of;
  const unembedded = (box?: number[]) => ctx.register(ctx.obj({ Type: 'Font', Subtype: 'TrueType', BaseFont: 'FixtureUnembedded',
    FirstChar: 32, LastChar: 126, Widths: Array(95).fill(600), Encoding: 'WinAnsiEncoding',
    ...(box && { FontDescriptor: ctx.register(ctx.obj({ Type: 'FontDescriptor', FontName: 'FixtureUnembedded', Flags: 32,
      FontBBox: box, ItalicAngle: 0, Ascent: 800, Descent: -200, CapHeight: 700, StemV: 80 })) }) }));
  const cff = matrixCff();
  cff.fill(14, cff.length - 13);
  const emptyPath = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Tiny', FirstChar: 65, LastChar: 67,
    Widths: [600, 600, 600], ToUnicode: ctx.register(ctx.flateStream('3 beginbfchar <41> <0041> <42> <0042> <43> <0043> endbfchar')),
    FontDescriptor: ctx.register(ctx.obj({ Type: 'FontDescriptor', FontName: 'Tiny', Flags: 1, FontBBox: [0, 0, 600, 700],
      Ascent: 700, Descent: -200, CapHeight: 700, ItalicAngle: 0, StemV: 80,
      FontFile3: ctx.register(ctx.flateStream(cff, { Subtype: 'Type1C' })) })) }));
  page.node.set(name('Resources'), ctx.obj({ Font: { F1: font.ref, F2: unembedded(),
    F3: unembedded([0, -200, 600, 800]), F4: unembedded([0, -4000, 600, 800]), F5: emptyPath } }));
  const e: Encode = text => font.encodeText(text).toString();
  const commands = [
    `BT /F1 9 Tf 1 0 0 1 32 ${y0} Tm ${e('01')} Tj ET`,
    `BT /F1 9 Tf 1 0 0 1 ${x0} 192 Tm ${e('SUMMARY')} Tj ET`,
    ...extra(e),
    `BT /F1 1 Tf ${tracking} Tc ${size} 0 0 ${size} ${x0} ${y0} Tm ${title(e)} ET`,
  ];
  page.node.set(name('Contents'), ctx.register(ctx.flateStream(commands.join('\n'))));
  const saved = await PDFDocument.load(await doc.save());
  const widths = saved.context.lookup(font.ref, PDFDict).lookup(name('DescendantFonts'), PDFArray).lookup(0, PDFDict).lookup(name('W'), PDFArray);
  for (const row of widths.asArray()) {
    if (row instanceof PDFArray) row.asArray().forEach((width, i) => row.set(i, PDFNumber.of(Math.trunc((width as PDFNumber).asNumber()))));
  }
  return saved.save();
}

async function correct(source: Uint8Array, from: string, to: string) {
  const native = openPdfium(library);
  try {
    const before = native.inspectPage(source, 0, true);
    const owned = before.glyphs.filter(g => g.fontSize > 17 && g.origin[1] === y0);
    const right = Math.max(...owned.map(g => g.inkBox[2]));
    const rect = { x: x0 - .15, y: y0 - 4, w: right - x0 + .35, h: 22 };
    const edit = overlay({ fontFamily: 'sans', fontSize: 18.42, originalText: from, text: to, rect, coverRects: [rect],
      sourceBaselinesPt: [y0], sourceGlyphs: owned.map(g => ({ text: g.text, x: g.origin[0], y: g.origin[1], advance: g.box[2] - g.origin[0] })) });
    const model = { pages: [{ id: 'p', sourceIndex: 0, widthPt: 400, heightPt: 300, rotation: 0 }], overlays: [edit] };
    const saved = await exportPdf(source, model, { mode: 'annotations' });
    const after = native.inspectPage(saved.bytes, 0, true);
    const poppler = Bun.which('pdftotext') ? Bun.spawnSync(['pdftotext', '-layout', '-', '-'], { stdin: saved.bytes }).stdout.toString() : undefined;
    return { before, after, saved, poppler, outcome: saved.contentTextOutcomes?.[0] };
  } finally {
    native.close();
  }
}

type Result = Awaited<ReturnType<typeof correct>>;
type Page = Result['before'];
const signature = (g: Page['glyphs'][number]) => [g.text, g.origin, g.inkBox, g.fontSize, g.fontHash];
// Readers lay out a substituted font afresh on each load, so glyphs in the
// unembedded fonts are compared through the content stream (`keepsShow`).
const neighbors = (page: Page) => {
  const embedded = page.glyphs.find(g => g.fontSize > 17)!.fontHash;
  return page.glyphs.filter(g => g.fontSize < 15 && g.fontHash === embedded).map(signature);
};
const pageContent = async (bytes: Uint8Array) => {
  const page = (await PDFDocument.load(bytes)).getPage(0), contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map(r => page.doc.context.lookup(r)) : [contents];
  return streams.map(s => new TextDecoder().decode(decodePDFRawStream(s as PDFRawStream).decode())).join('\n');
};
const keepsShow = async (bytes: Uint8Array, show: string) => expect(await pageContent(bytes)).toContain(show);
const title = (page: Page) => page.glyphs.filter(g => g.fontSize > 17 && g.text.trim()).sort((a, b) => a.origin[0] - b.origin[0]);
const fitted = (outcome: Result['outcome']) =>
  outcome?.mode === 'in-place' && 'sourceSpacingAdjusted' in outcome && outcome.sourceSpacingAdjusted === true;

function expectFittedLine(result: Result, to: string, searchable = true) {
  expect(result.outcome).toMatchObject({ mode: 'in-place', sourceSpacingAdjusted: true });
  expect(neighbors(result.after)).toEqual(neighbors(result.before));
  const line = title(result.after);
  expect(line.map(g => g.text).join('')).toBe(to.replace(/\s/gu, ''));
  expect(new Set(line.map(g => g.origin[1]))).toEqual(new Set([y0]));
  expect(Math.max(...line.map(g => Math.abs(g.fontSize - size)))).toBeLessThanOrEqual(.01);
  if (!searchable) return;
  expect(result.after.text).toContain(to);
  if (result.poppler !== undefined) expect(result.poppler).toContain(to);
}
const checklist = (extra: (e: Encode) => string[]) => fixture(e => `${e('CHEKLIST')} Tj`, extra)
  .then(source => correct(source, 'CHEKLIST', 'CHECKLIST'));

// Neighbours are measured, not guessed: a far glyph whose bound is known
// does not block the fit, a glyph whose bound reaches the moved ink must
// be clear of it, and a glyph with no bound at all refuses the fit.
nativeTest('a rotated label far from the correction does not block the fit', async () => {
  expectFittedLine(await checklist(e => [`BT /F1 9 Tf 0 1 -1 0 380 20 Tm ${e('DRAFT')} Tj ET`]), 'CHECKLIST');
});

nativeTest('a rotated glyph above the word, clear of its ink, does not block the fit', async () => {
  expectFittedLine(await checklist(e => [`BT /F1 9 Tf 0 1 -1 0 120 ${y0 + 15} Tm ${e('X')} Tj ET`]), 'CHECKLIST');
});

nativeTest('a rotated glyph across the moved ink refuses the fit', async () => {
  expect(fitted((await checklist(e => [`BT /F1 9 Tf 0 1 -1 0 128 ${y0 + 4} Tm ${e('H')} Tj ET`])).outcome)).toBe(false);
});

for (const [label, show] of [
  ['an ordinary declared bounding box', `BT /F3 9 Tf 1 0 0 1 120 ${y0 + 16} Tm (NOTE) Tj ET`],
  ['a bounding box reaching far below its line', 'BT /F4 9 Tf 1 0 0 1 300 30 Tm (FAR) Tj ET'],
] as const) nativeTest(`an unembedded label with ${label}, clear of the moved ink, does not block the fit`, async () => {
  const result = await checklist(() => [show]);
  expectFittedLine(result, 'CHECKLIST');
  await keepsShow(result.saved.bytes, show);
});

nativeTest('a declared bounding box overhanging more than an em into the moved ink refuses the fit', async () => {
  expect(fitted((await checklist(() => [`BT /F4 9 Tf 1 0 0 1 120 ${y0 + 40} Tm (NOTE) Tj ET`])).outcome)).toBe(false);
});

nativeTest('a label whose ink has no bound refuses the fit, however far away', async () => {
  expect(fitted((await checklist(() => ['BT /F2 9 Tf 1 0 0 1 300 30 Tm (FAR) Tj ET'])).outcome)).toBe(false);
});

for (const [where, at] of [['inside the moved ink', `100 ${y0 + 5}`], ['far away', '300 30']] as const) {
  nativeTest(`a glyph whose empty outline is unproved refuses the fit, ${where}`, async () => {
    expect(fitted((await checklist(() => [`BT /F5 9 Tf 1 0 0 1 ${at} Tm (A) Tj ET`])).outcome)).toBe(false);
  });
}

nativeTest('invisible text inside the moved ink does not block the fit', async () => {
  const result = await checklist(e => [`q BT 3 Tr /F1 9 Tf 1 0 0 1 100 ${y0 + 5} Tm ${e('OCR')} Tj ET Q`]);
  expectFittedLine(result, 'CHECKLIST', false);
});

// A separator keeps all but the reserve (40% of the painted tracking, at
// most .08 em) of its width, whether it is a space glyph or a TJ move.
const reserve = Math.min(.08 * size, .4 * .18 * size);
const gap = (page: Page, word: number) => { const line = title(page); return line[word]!.inkBox[0] - line[word - 1]!.inkBox[2]; };
for (const [label, show] of [
  ['a kerned TJ word break', (e: Encode) => `[${e('BRIEFNG')} -350 ${e('NOTES')}] TJ`],
  ['a space between words', (e: Encode) => `${e('BRIEFNG NOTES')} Tj`],
] as const) {
  nativeTest(`${label} fits within the separator reserve`, async () => {
    const result = await correct(await fixture(show), 'BRIEFNG NOTES', 'BRIEFING NOTES');
    expectFittedLine(result, 'BRIEFING NOTES');
    const kept = gap(result.after, 8), authored = gap(result.before, 7);
    expect(kept).toBeLessThan(authored);
    expect(kept).toBeGreaterThanOrEqual(authored - reserve - .01);
  });
  // Inserting C costs 2.08 pt per glyph across CHEK LIST; the reserve is 1.33 pt.
  nativeTest(`${label} that the insertion would narrow past the reserve refuses the fit`, async () => {
    const result = await correct(await fixture(e => show(e).replace(/BRIEFNG/gu, 'CHEK').replace(/NOTES/gu, 'LIST')), 'CHEK LIST', 'CHECK LIST');
    expect(fitted(result.outcome)).toBe(false);
  });
}

// The fit spends authored tracking; it needs some (.06 em as painted) and
// may never spend more than there is.
const spacings = async (bytes: Uint8Array) => [...(await pageContent(bytes)).matchAll(/(-?[\d.]+)\s+Tc\b/gu)].map(m => Number(m[1]));
nativeTest('condensed text whose painted tracking is under .06 em is not fitted', async () => {
  // .18 Tc at 20 Tz paints .66 pt between glyphs, under 1.1 pt.
  const result = await correct(await fixture(e => `20 Tz ${e('LINN')} Tj`), 'LINN', 'LINEN');
  expect(fitted(result.outcome)).toBe(false);
  expect(Math.min(...await spacings(result.saved.bytes))).toBeGreaterThanOrEqual(0);
});

nativeTest('an insertion wider than the tracking it can spend is not fitted', async () => {
  // E costs .21 em per glyph across LINN; .18 em of tracking is all there is.
  const result = await correct(await fixture(e => `${e('LINN')} Tj`), 'LINN', 'LINEN');
  expect(fitted(result.outcome)).toBe(false);
  const written = await spacings(result.saved.bytes);
  expect(written.length).toBeGreaterThan(0);
  expect(Math.min(...written)).toBeGreaterThanOrEqual(0);
});

// .05 Tc is under .06 em before scaling, but 150 Tz paints a wider gap.
nativeTest('expanded text is judged on its painted tracking', async () => {
  expectFittedLine(await correct(await fixture(e => `150 Tz ${e('POSITONING')} Tj`, () => [], .05), 'POSITONING', 'POSITIONING'), 'POSITIONING');
});
