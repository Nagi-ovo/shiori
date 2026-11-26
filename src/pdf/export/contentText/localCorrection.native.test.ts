import { expect, test } from 'bun:test';
import fontkit from '@pdf-lib/fontkit';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { PDFDict, PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import { openPdfium } from '../../../../scripts/pdf-inplace/nativePdfium';
import { exportPdf } from '../exportPdf';
import { inspectRunPage } from '../contentStreamEdit/replaceRunPage';
import { model, overlay } from './fixtures.test-support';

const library = 'vendor/pdfium/linux-x64/lib/libpdfium.so';
const nativeTest = test.skipIf(!existsSync(library));
const loadFont = (face: string) => readFile(`node_modules/@docx-editor.dev/fonts/assets/${face}`);
const options = { mode: 'annotations' as const, inPlaceFallback: { loadFont } };

async function fixture(show: string, font: 'embedded' | 'standard', extra = {}, clip = false) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const ctx = doc.context;
  const data = font === 'embedded' ? await loadFont('LiberationSans-Regular.ttf') : undefined;
  const parsed = data && fontkit.create(data);
  const widths = parsed && Array.from({ length: 95 }, (_, i) =>
    Math.round(1000 * parsed.glyphForCodePoint(i + 32).advanceWidth / parsed.unitsPerEm));
  const descriptor = data && ctx.register(ctx.obj({
    Type: 'FontDescriptor', FontName: 'LiberationSans', Flags: 32, FontBBox: [-600, -400, 1300, 1100],
    ItalicAngle: 0, Ascent: 900, Descent: -220, CapHeight: 690, StemV: 80,
    FontFile2: ctx.register(ctx.flateStream(data, { Length1: data.length })),
  }));
  const fontRef = ctx.register(ctx.obj({
    Type: 'Font', Subtype: data ? 'TrueType' : 'Type1', BaseFont: data ? 'LiberationSans' : 'Helvetica',
    Encoding: 'WinAnsiEncoding', ...(data ? { FirstChar: 32, LastChar: 126, Widths: widths, FontDescriptor: descriptor } : {}),
    ...extra,
  }));
  page.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: fontRef } }));
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(
    `${clip ? 'q 40 93 90 22 re W n ' : ''}BT /F1 10 Tf 50 100 Td ${show} ET${clip ? ' Q' : ''}`,
  )));
  return doc.save();
}

async function inspect(bytes: Uint8Array) {
  const pdfium = openPdfium(library);
  try {
    const page = pdfium.inspectPage(bytes, 0, true);
    return { text: page.text, ink: page.glyphs.filter(g => g.text.trim()).map(g => ({
      text: g.text, origin: g.origin, box: g.box, fontSize: g.fontSize, fontHash: g.fontHash,
    })) };
  } finally {
    pdfium.close();
  }
}

async function editField(source: Uint8Array, originalText: string, text: string, width: number) {
  const rect = { x: 49.99, y: 98, w: width + 0.02, h: 12 };
  const { ink } = await inspect(source);
  const sourceGlyphs = ink.map(g => ({ text: g.text, x: g.origin[0], y: g.origin[1], advance: g.box[2] - g.origin[0] }));
  const edit = { ...overlay({ originalText, text, rect, coverRects: [rect],
    sourceBaselinesPt: [100], fontFamily: 'sans' }), sourceGlyphs };
  return exportPdf(source, model([edit]), options);
}

for (const [label, originalText, replacement, width] of [
  ['one glyph', '6', '8', 5.56],
  ['whole field', '6,800.00', '8,800.00', 38.92],
] as const) {
  nativeTest(`a clipped embedded amount keeps all authored origins and size from a ${label} selection`, async () => {
    const source = await fixture('[(6,800.00) -1800 (LOCK)] TJ', 'embedded', {}, true);
    const before = await inspect(source);
    const output = await editField(source, originalText, replacement, width);
    const after = await inspect(output.bytes);
    expect(after.text).toBe('8,800.00 LOCK');
    expect(after.ink.map(g => g.fontHash)).toEqual(before.ink.map(g => g.fontHash));
    for (const [i, glyph] of after.ink.entries()) {
      expect(glyph.origin[0]).toBeCloseTo(before.ink[i]!.origin[0], 2);
      expect(glyph.origin[1]).toBeCloseTo(100, 2);
      expect(glyph.fontSize).toBeCloseTo(10, 2);
    }
    const page = (await PDFDocument.load(output.bytes)).getPage(0);
    const content = inspectRunPage(page);
    expect(content.ok && new TextDecoder().decode(content.bytes)).toContain('re W n');
  });
}

nativeTest('a proportional correction moves the kerned suffix and anchors the next field after an inferred space', async () => {
  const source = await fixture('[(i) 50 (A-B) -1800 (LOCK)] TJ', 'embedded');
  const before = await inspect(source);
  const output = await editField(source, 'iA-B', 'lA-B', 18.39);
  const after = await inspect(output.bytes);
  expect(after.text).toBe('lA-B LOCK');
  expect(after.ink.map(g => g.fontHash)).toEqual(before.ink.map(g => g.fontHash));
  expect(after.ink.map(g => g.origin)).toEqual(before.ink.map(g => g.origin));

  const wider = await editField(source, 'iA-B', 'fA-B', 18.39);
  const changed = await inspect(wider.bytes);
  expect(changed.text).toBe('fA-B LOCK');
  expect(changed.ink[0]!.origin).toEqual(before.ink[0]!.origin);
  for (const i of [1, 2, 3]) expect(changed.ink[i]!.origin[0] - before.ink[i]!.origin[0]).toBeCloseTo(0.56, 2);
  expect(changed.ink.slice(4).map(g => g.origin)).toEqual(before.ink.slice(4).map(g => g.origin));
});

nativeTest('unembedded Helvetica with a published encoding keeps all eight authored origins', async () => {
  const source = await fixture('(7,600.00) Tj', 'standard');
  const before = await inspect(source);
  const output = await editField(source, '7,600.00', '9,600.00', 38.92);
  const after = await inspect(output.bytes);
  expect(after.text).toBe('9,600.00');
  expect(output.contentTextOutcomes?.[0]?.mode).toBe('in-place');
  expect(after.ink.map(g => [g.origin, g.fontSize, g.fontHash])).toEqual(
    before.ink.map(g => [g.origin, g.fontSize, g.fontHash]));
});

for (const [label, extra, customWidth] of [
  ['conflicting widths', { FirstChar: 32, LastChar: 126, Widths: Array(95).fill(620) }, 49.6],
  ['custom encoding', { Encoding: { BaseEncoding: 'WinAnsiEncoding', Differences: [PDFNumber.of(55), PDFName.of('seven')] } }, 38.92],
] as const) {
  nativeTest(`readable Helvetica with ${label} preserves the original field and explains the metrics refusal`, async () => {
    const source = await fixture('(7,600.00) Tj', 'standard', extra);
    const before = await inspect(source);
    expect(before.text).toBe('7,600.00');
    const result = await editField(source, '7,600.00', '9,600.00', customWidth);
    expect(result.contentTextOutcomes?.[0]).toMatchObject({ mode: 'unsupported', reason: 'unsupported-unverified-text' });
    const after = await inspect(result.bytes);
    expect(after).toEqual(before);
  });
}

nativeTest('a bad unrelated ToUnicode entry does not displace a proved CID digit', async () => {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(await loadFont('LiberationSans-Regular.ttf'));
  const page = doc.addPage([300, 200]);
  page.drawText('6,800.00', { x: 50, y: 100, size: 10, font });
  // Reload to keep the normal font embedder from regenerating ToUnicode on save.
  const withBadLabel = await PDFDocument.load(await doc.save());
  const dict = withBadLabel.context.lookup(font.ref);
  if (!(dict instanceof PDFDict)) throw new Error('expected font dictionary');
  const codes = [...'6,80.'].map(ch => `${font.encodeText(ch)} <${ch.charCodeAt(0).toString(16).padStart(4, '0')}>`);
  dict.set(PDFName.of('ToUnicode'), withBadLabel.context.register(withBadLabel.context.flateStream(
    `6 beginbfchar ${codes.join(' ')} <ffff> <d800> endbfchar`,
  )));
  const source = await withBadLabel.save();
  const before = await inspect(source);
  expect(before.text).toBe('6,800.00');
  const result = await editField(source, '6,800.00', '8,800.00', 38.92);
  const after = await inspect(result.bytes);
  expect(after.text).toBe('8,800.00');
  for (const [i, glyph] of after.ink.entries()) {
    expect(glyph.origin[0]).toBeCloseTo(before.ink[i]!.origin[0], 2);
    expect(glyph.fontSize).toBeCloseTo(10, 2);
    expect(glyph.fontHash).toBe(before.ink[i]!.fontHash);
  }
});

const savedField = (originalText = '7,600.00', width = 38.92) => {
  const rect = { x: 49.99, y: 98, w: width + 0.02, h: 12 };
  return overlay({ originalText, text: '9,600.00', rect, coverRects: [rect],
    sourceBaselinesPt: [100], fontFamily: 'sans' });
};

nativeTest('an old draft without observations preserves readable standard text and identifies the missing proof', async () => {
  const source = await fixture('(7,600.00) Tj', 'standard');
  const before = await inspect(source);
  const result = await exportPdf(source, model([savedField()]), options);
  expect(before.text).toBe('7,600.00');
  expect(result.contentTextOutcomes?.[0]).toMatchObject({
    mode: 'unsupported', reason: 'unsupported-unverified-text',
  });
  expect(await inspect(result.bytes)).toEqual(before);
});

nativeTest('fresh page measurements recover an old standard-font draft at all eight original positions', async () => {
  const source = await fixture('(7,600.00) Tj', 'standard');
  const before = await inspect(source);
  const glyphs = before.ink.map(g => ({
    text: g.text, origin: { x: g.origin[0], y: g.origin[1] },
    end: { x: g.box[2], y: g.origin[1] },
  }));
  const result = await exportPdf(source, model([savedField()]), { ...options, readSourceGlyphs: async () => glyphs });
  const after = await inspect(result.bytes);
  expect(result.contentTextOutcomes?.[0]).toMatchObject({
    mode: 'in-place', fidelity: 'approximate', standardFontMetrics: true,
  });
  expect(after.text).toBe('9,600.00');
  expect(after.ink.map(g => [g.origin, g.fontSize, g.fontHash]))
    .toEqual(before.ink.map(g => [g.origin, g.fontSize, g.fontHash]));
});

for (const [label, extra, width] of [
  ['conflicting widths', { FirstChar: 32, LastChar: 126, Widths: Array(95).fill(620) }, 49.6],
  ['an encoding with Differences', { Encoding: { BaseEncoding: 'WinAnsiEncoding', Differences: [PDFNumber.of(55), PDFName.of('seven')] } }, 38.92],
] as const) {
  nativeTest(`a legacy draft over readable standard text with ${label} preserves the source`, async () => {
    const source = await fixture('(7,600.00) Tj', 'standard', extra);
    const before = await inspect(source);
    const result = await exportPdf(source, model([savedField('7,600.00', width)]), options);
    expect(before.text).toBe('7,600.00');
    expect(result.contentTextOutcomes?.[0]).toMatchObject({
      mode: 'unsupported', reason: 'unsupported-unverified-text',
    });
    expect(await inspect(result.bytes)).toEqual(before);
  });
}

for (const [label, scan] of [['empty page', false], ['image-only page', true]] as const) {
  nativeTest(`an old draft describing text on an ${label} does not establish readable text`, async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 200]);
    if (scan) {
      const ctx = doc.context;
      const image = ctx.register(ctx.flateStream(Uint8Array.of(0, 255), {
        Type: 'XObject', Subtype: 'Image', Width: 2, Height: 1, ColorSpace: 'DeviceGray', BitsPerComponent: 8,
      }));
      page.node.set(PDFName.of('Resources'), ctx.obj({ XObject: { Im: image } }));
      page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream('q 200 0 0 80 40 60 cm /Im Do Q')));
    }
    const source = await doc.save();
    const result = await exportPdf(source, model([savedField()]), options);
    expect(result.contentTextOutcomes?.[0]).toMatchObject({
      mode: 'unsupported', reason: 'unsupported-no-text-layer',
    });
    expect(await inspect(result.bytes)).toEqual(await inspect(source));
  });
}
