import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import fontkit from '@pdf-lib/fontkit';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import { openPdfium } from '../../../../scripts/pdf-inplace/nativePdfium';
import { exportPdf } from '../exportPdf';
import { renderFixtureRegion } from '../../../../scripts/pdf-inplace/fixtureRaster.test-support';
import { model, overlay } from './fixtures.test-support';

const library = 'vendor/pdfium/linux-x64/lib/libpdfium.so';
const nativeTest = test.skipIf(!existsSync(library));
const size = 18.4164;
const beforeText = 'DIGTAL DESIGN STUDIO';
const afterText = 'DIGITAL DESIGN STUDIO';

function decoratedImage(muted: boolean, secondMark: boolean) {
  const width = 600, height = 400;
  const bytes = new Uint8Array(width * height * 3).fill(232);
  if (muted) for (let i = 0; i < bytes.length; i += 3) bytes.set([223, 230, 232], i);
  // An independent printed index in the gap left by the authored line.
  for (let y = 176; y < 193; y++) for (let x = 120; x < 125; x++) {
    const i = 3 * (y * width + x);
    bytes.set(muted ? [200, 211, 232] : [24, 90, 220], i);
  }
  // A second subdued mark sits in the unpainted side of the next letter,
  // below its top bar. Both marks must survive the new spacing.
  if (secondMark) for (let y = 181; y < 193; y++) for (let x = 128; x < 132; x++) {
    bytes.set([200, 211, 232], 3 * (y * width + x));
  }
  return { bytes, width, height, color: 'DeviceRGB' };
}

async function fixture(printedIndex = false, muted = false, captionY = muted ? 48 : 79, secondMark = muted) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(readFileSync('node_modules/@docx-editor.dev/fonts/assets/LiberationSans-Regular.ttf'));
  const page = doc.addPage([300, 200]);
  const ctx = doc.context;
  const bitmap = printedIndex ? decoratedImage(muted, secondMark) :
    { bytes: Uint8Array.of(222, 216, 230, 224), width: 2, height: 2, color: 'DeviceGray' };
  const image = ctx.register(ctx.flateStream(bitmap.bytes, {
    Type: 'XObject', Subtype: 'Image', Width: bitmap.width, Height: bitmap.height, ColorSpace: bitmap.color, BitsPerComponent: 8,
  }));
  const form = ctx.register(ctx.flateStream('q 300 0 0 200 0 0 cm /Paper Do Q', {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 300, 200], Resources: { XObject: { Paper: image } },
  }));
  page.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: font.ref }, XObject: { Backdrop: form } }));
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(
    'q 0 0 300 200 re W n /Backdrop Do Q\n' +
    'BT /F1 10 Tf 1 0 0 1 22 121 Tm ' + font.encodeText('VOLUME II') + ' Tj\n' +
    `/F1 1 Tf .16 Tc -.16 Tw ${size} 0 0 ${size} 22 100 Tm ${font.encodeText(beforeText)} Tj\n` +
    `/F1 10 Tf 0 Tc 0 Tw 1 0 0 1 22 ${captionY} Tm ` + font.encodeText('ARCHIVE 02') + ' Tj ET\n' +
    '0 .2 .4 RG 1 w 22 94 m 284 94 l S',
  )));
  const saved = await PDFDocument.load(await doc.save());
  const parent = saved.context.lookup(font.ref, PDFDict);
  const child = parent.lookup(PDFName.of('DescendantFonts'), PDFArray).lookup(0, PDFDict);
  const widths = child.lookup(PDFName.of('W'), PDFArray);
  for (const row of widths.asArray()) {
    if (!(row instanceof PDFArray)) continue;
    row.asArray().forEach((width, i) => row.set(i, PDFNumber.of(Math.trunc((width as PDFNumber).asNumber()))));
  }
  return saved.save();
}

test.skipIf(!existsSync(library) || !Bun.which('pdftoppm') || !Bun.which('pdftotext'))('fits a one-letter title correction over earlier artwork at the authored size and ink edge', async () => {
  const source = await fixture();
  const native = openPdfium(library);
  try {
    const before = native.inspectPage(source, 0, true);
    const selected = before.glyphs.filter(g => g.origin[1] === 100);
    const right = Math.max(...selected.map(g => g.inkBox[2]));
    const rect = { x: 21.95, y: 96, w: right - 21.8, h: 23 };
    const edit = overlay({
      originalText: beforeText, text: afterText, rect, coverRects: [rect],
      sourceBaselinesPt: [100], fontSize: 18.42, fontFamily: 'sans',
      sourceGlyphs: selected.map(g => ({ text: g.text, x: g.origin[0], y: g.origin[1], advance: g.box[2] - g.origin[0] })),
    });
    const output = await exportPdf(source, model([edit]), { mode: 'annotations', renderContentText: renderFixtureRegion });
    if (process.env.R35_FIXTURE_OUT) {
      writeFileSync(`${process.env.R35_FIXTURE_OUT}/title-before.pdf`, source);
      writeFileSync(`${process.env.R35_FIXTURE_OUT}/title-after.pdf`, output.bytes);
    }
    const after = native.inspectPage(output.bytes, 0, true);
    expect(after.text.split(/\r?\n/).map(line => line.trim())).toEqual(['VOLUME II', afterText, 'ARCHIVE 02']);
    const search = Bun.spawn(['pdftotext', '-layout', '-', '-'], {
      stdin: new Blob([new Uint8Array(output.bytes)]), stdout: 'pipe',
    });
    const text = await new Response(search.stdout).text();
    expect(await search.exited).toBe(0);
    expect(text.split('\n').some(line => line.trim() === afterText)).toBeTrue();
    const corrected = after.glyphs.filter(g => g.origin[1] === 100);
    expect(corrected.map(g => g.text).join('').replaceAll(' ', '')).toBe(afterText.replaceAll(' ', ''));
    expect(Math.max(...corrected.map(g => Math.abs(g.fontSize - size)))).toBeLessThanOrEqual(.01);
    expect(Math.abs(Math.max(...corrected.map(g => g.inkBox[2])) - right)).toBeLessThanOrEqual(.1);
    const neighbor = (g: typeof selected[number]) => [g.text, g.origin, g.inkBox, g.fontSize, g.fontHash];
    expect(after.glyphs.filter(g => g.origin[1] !== 100).map(neighbor)).toEqual(
      before.glyphs.filter(g => g.origin[1] !== 100).map(neighbor));
    expect(corrected[0]!.origin).toEqual(selected[0]!.origin);
    expect(Math.abs(corrected.at(-1)!.origin[0] - selected.at(-1)!.origin[0])).toBeLessThan(.001);
  } finally {
    native.close();
  }
});

for (const muted of [false, true]) nativeTest(`saves a correction with room to wrap while preserving a ${muted ? 'muted' : 'contrasting'} index`, async () => {
  const source = await fixture(true, muted, 48, false);
  const native = openPdfium(library);
  try {
    const before = native.inspectPage(source, 0, true);
    const selected = before.glyphs.filter(g => g.origin[1] === 100);
    const right = Math.max(...selected.map(g => g.inkBox[2]));
    const rect = { x: 21.95, y: 96, w: right - 21.8, h: 23 };
    const edit = overlay({
      originalText: beforeText, text: afterText, rect, coverRects: [rect],
      sourceBaselinesPt: [100], fontSize: 18.42, fontFamily: 'sans',
      sourceGlyphs: selected.map(g => ({ text: g.text, x: g.origin[0], y: g.origin[1], advance: g.box[2] - g.origin[0] })),
    });
    const neighbor = (g: typeof selected[number]) => [g.text, g.origin, g.inkBox, g.fontSize, g.fontHash];
    const printedPixels = ({ pixels }: typeof before) => {
      const occupied = [];
      for (let i = 0; i < pixels!.length; i += 4) {
        const r = pixels![i + 2]!, g = pixels![i + 1]!, b = pixels![i]!;
        if (muted ? b > 211 && b - r > 15 && b - g > 12 : b - r > 100 && b - g > 70) occupied.push(i);
      }
      return occupied;
    };
    expect(printedPixels(before).length).toBeGreaterThan(50);
    const renderers = Bun.which('pdftoppm') ? [undefined, renderFixtureRegion] : [undefined];
    for (const renderContentText of renderers) {
      const saved = await exportPdf(source, model([edit]), { mode: 'annotations', renderContentText });
      const after = native.inspectPage(saved.bytes, 0, true);
      const title = after.glyphs.filter(g => g.origin[1] > 60 && g.origin[1] < 120);
      expect(after.text.replace(/\s+/gu, ' ')).toBe(`VOLUME II ${afterText} ARCHIVE 02`);
      if (!renderContentText) expect(saved.contentTextOutcomes?.[0]).toMatchObject({ mode: 'retypeset', retypeset: { lineCount: 2, pushed: false } });
      expect(Math.max(...title.map(g => Math.abs(g.fontSize - size)))).toBeLessThanOrEqual(.01);
      expect(printedPixels(after)).toEqual(printedPixels(before));
      expect(after.glyphs.filter(g => g.origin[1] === 121 || g.origin[1] === 48).map(neighbor)).toEqual(
        before.glyphs.filter(g => g.origin[1] === 121 || g.origin[1] === 48).map(neighbor));
    }
  } finally {
    native.close();
  }
});

for (const muted of [false, true]) nativeTest(`saving a tracked correction preserves the ${muted ? 'muted' : 'contrasting'} printed index`, async () => {
  const source = await fixture(true, muted);
  const native = openPdfium(library);
  try {
    const before = native.inspectPage(source, 0, true);
    const glyphs = before.glyphs.filter(g => g.origin[1] === 100);
    const right = Math.max(...glyphs.map(g => g.inkBox[2]));
    const rect = { x: 21.95, y: 96, w: right - 21.8, h: 23 };
    const edit = overlay({
      originalText: beforeText, text: afterText, rect, coverRects: [rect],
      sourceBaselinesPt: [100], fontSize: 18.42, fontFamily: 'sans',
      sourceGlyphs: glyphs.map(g => ({ text: g.text, x: g.origin[0], y: g.origin[1], advance: g.box[2] - g.origin[0] })),
    });
    const saved = await exportPdf(source, model([edit]), { mode: 'annotations' });
    const after = native.inspectPage(saved.bytes, 0, true);
    const blue = ({ pixels }: typeof before) => {
      const occupied = [];
      for (let i = 0; i < pixels!.length; i += 4) {
        const r = pixels![i + 2]!, g = pixels![i + 1]!, b = pixels![i]!;
        if (muted ? b > 211 && b - r > 15 && b - g > 12 : b - r > 100 && b - g > 70) occupied.push(i);
      }
      return occupied;
    };
    expect(blue(before).length).toBeGreaterThan(50);
    expect(blue(after)).toEqual(blue(before));
    if (saved.contentTextOutcomes?.[0]?.mode === 'unsupported') expect(after.text).toBe(before.text);
    else expect(after.text.replace(/\s/gu, '')).toContain(afterText.replaceAll(' ', ''));
    if (Bun.which('pdftoppm')) {
      const measured = await exportPdf(source, model([edit]), { mode: 'annotations', renderContentText: renderFixtureRegion });
      const readback = native.inspectPage(measured.bytes, 0, true);
      expect(blue(readback)).toEqual(blue(before));
    }
  } finally {
    native.close();
  }
});
