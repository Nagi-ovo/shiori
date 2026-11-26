import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { PDFDocument, PDFName } from 'pdf-lib';
import { model, overlay } from '../../pdf/export/contentText/fixtures.test-support';
import { renderFixtureRegion as raster } from '../../../scripts/pdf-inplace/fixtureRaster.test-support';
import { buildContentTextPreview } from './contentTextPreview';
import { exportPdf } from '../../pdf/export/exportPdf';

// The visible cases use the counter of a wide O and the filled middle of a
// contrasting I. The source and replacement share the same origin and size.
const nativeTest = test.skipIf(!Bun.which('pdftoppm'));
const rows = [
  { id: 'label-front-rule', before: 'O', after: 'I', shape: '1 0 0 rg 111.7 106 1 10 re f', foreground: true, expected: 'new-collision' },
  { id: 'label-back-rule', before: 'O', after: 'I', shape: '1 0 0 rg 111.7 106 1 10 re f', foreground: false, expected: 'new-collision' },
  { id: 'label-no-contact', before: 'O', after: 'I', shape: '1 0 0 rg 150 106 1 10 re f', foreground: true, expected: 'clear' },
  { id: 'label-old-contact', before: 'I', after: 'O', shape: '1 0 0 rg 111.7 106 1 10 re f', foreground: true, expected: 'pre-existing-contact' },
  { id: 'label-print-over-text', before: 'I', after: 'H',
    shape: 'BT 1 0 0 rg /F1 20 Tf 1 0 0 1 112.4 107.2 Tm (I) Tj ET', foreground: true, expected: 'new-collision' },
  { id: 'label-unknown-graphic', before: 'O', after: 'I', shape: 'q 50 0 0 25 95 97 cm /Art Do Q', foreground: false, expected: 'uncertain' },
  { id: 'label-on-inset-panel', before: 'O', after: 'I', shape: '',
    foreground: false, expected: 'clear' },
  { id: 'label-two-nested-rules', before: 'O', after: 'I', shape: '/Frame Do', foreground: true, expected: 'new-collision' },
] as const;

const settings = { fontSize: 40, fontFamily: 'mono' as const, rect: { x: 99.9, y: 96, w: 24.2, h: 36 } };
const page = model([]).pages[0]!;

async function fixture(row: typeof rows[number]) {
  const doc = await PDFDocument.create();
  const p = doc.addPage([300, 200]);
  const ctx = doc.context;
  const font = ctx.register(ctx.obj({
    Type: 'Font', Subtype: 'Type1', BaseFont: 'Courier-Bold', Encoding: 'WinAnsiEncoding',
    FirstChar: 32, LastChar: 126, Widths: Array(95).fill(600),
    ToUnicode: ctx.register(ctx.flateStream('1 beginbfrange <20> <7e> <0020> endbfrange')),
  }));
  const art = ctx.register(ctx.flateStream(Uint8Array.of(40, 200), {
    Type: 'XObject', Subtype: 'Image', Width: 2, Height: 1, ColorSpace: 'DeviceGray', BitsPerComponent: 8,
  }));
  const inks = ctx.register(ctx.flateStream('0 0 1 rg 102 106 5 12 re f 1 0 0 rg 111.75 106 1 10 re f', {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 300, 200], Resources: {},
  }));
  const frame = ctx.register(ctx.flateStream('/Artifact BMC q /Solid gs /Ink Do Q EMC', {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 300, 200],
    Resources: { XObject: { Ink: inks }, ExtGState: { Solid: { Type: 'ExtGState', BM: 'Normal', ca: 1, CA: 1 } } },
  }));
  p.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: font }, XObject: { Art: art, Frame: frame } }));
  const inset = row.id === 'label-on-inset-panel';
  const label = `BT ${inset ? '.95 g' : '0 g'} /F1 40 Tf 1 0 0 1 100 100 Tm (${row.before}) Tj ET`;
  const stream = ['.95 g 0 0 300 200 re f', ...(inset ? ['.15 g 79 82 71 71 re f'] : []), ...(row.foreground ? [label, row.shape] : [row.shape, label])].join('\n');
  p.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(stream)));
  return doc.save();
}

for (const row of rows) nativeTest(`classifies visible contact for ${row.id} in the editor preview`, async () => {
  const source = await fixture(row);
  const value = overlay({ ...settings, originalText: row.before, text: row.after, coverRects: [settings.rect],
    bold: true, sourceBaselinesPt: [100], sourceGlyphs: [{ text: row.before, x: 100, y: 100, advance: 24 }] });
  const preview = await buildContentTextPreview(source, page, [value], undefined, raster);
  expect(preview.bytes).toBeTruthy();
  const dir = process.env.R35_FIXTURE_OUT;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/${row.id}-before.pdf`, source);
    writeFileSync(`${dir}/${row.id}-after.pdf`, preview.bytes!);
    writeFileSync(`${dir}/${row.id}-outcomes.json`, JSON.stringify(preview.outcomes, null, 2));
  }
  expect(preview.outcomes[0]).toMatchObject({ contact: { kind: row.expected } });
  if (row.expected === 'new-collision') {
    const region = preview.outcomes[0]!.contact!.region!;
    expect(region.x).toBeLessThanOrEqual(row.id === 'label-print-over-text' ? 121 : 113);
    expect(region.x + region.w).toBeGreaterThan(111.7);
    expect(region.y + region.h).toBeGreaterThan(106);
    if (row.id === 'label-two-nested-rules') {
      expect(region.x).toBeCloseTo(111.75, 1);
      expect(region.y).toBeCloseTo(106, 1);
      expect(region.w).toBeLessThanOrEqual(1.25);
    }
  }
}, 10000);

nativeTest('finds fine new contact from a wrapped label inside a clipped Form occurrence', async () => {
  const doc = await PDFDocument.create();
  const p = doc.addPage([300, 200]);
  const ctx = doc.context;
  const font = ctx.register(ctx.obj({
    Type: 'Font', Subtype: 'Type1', BaseFont: 'Courier-Bold', Encoding: 'WinAnsiEncoding',
    FirstChar: 32, LastChar: 126, Widths: Array(95).fill(600),
    ToUnicode: ctx.register(ctx.flateStream('1 beginbfrange <20> <7e> <0020> endbfrange')),
  }));
  const label = ctx.register(ctx.flateStream('BT /F1 20 Tf 20 TL 80 120 Td (O) Tj ET', {
    Type: 'XObject', Subtype: 'Form', BBox: [68, 93, 150, 155], Resources: { Font: { F1: font } },
  }));
  p.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: font }, XObject: { Label: label } }));
  p.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(
    'q 68 90 95 64 re W n /Label Do Q 1 0 0 rg 85.4 100.1 .45 2.5 re f',
  )));
  const rect = { x: 79.8, y: 116, w: 12.4, h: 19 };
  const value = overlay({ originalText: 'O', text: 'O\nI', rect, coverRects: [rect], sourceBaselinesPt: [120],
    fontSize: 20, bold: true, sourceGlyphs: [{ text: 'O', x: 80, y: 120, advance: 12 }] });
  const source = await doc.save();
  let renders = 0;
  const measured: typeof raster = (...args) => { renders++; return raster(...args); };
  const preview = await buildContentTextPreview(source, page, [value], undefined, measured);
  expect(preview.bytes).toBeTruthy();
  expect(preview.outcomes[0]).toMatchObject({ contact: { kind: 'new-collision' } });
  expect(preview.outcomes[0]!.contact!.region!.x).toBeCloseTo(85.4, 0);
  const previewRenders = renders;
  renders = 0;
  const options = { mode: 'flatten', renderContentText: measured } as const;
  const exported = await exportPdf(source, model([value]), options);
  expect(previewRenders).toBeGreaterThan(0);
  expect(renders).toBe(previewRenders);
  expect(preview.acceptance.findings).toEqual(exported.acceptance.findings);
  expect(preview.acceptance.status).toBe(exported.acceptance.status);
  const strict = await buildContentTextPreview(source, page, [value], undefined, measured, { acceptance: 'strict' });
  expect(strict.bytes).toBeNull();
  expect(strict.outcomes).toMatchObject([{ mode: 'unsupported', reason: 'acceptance-strict' }]);
  expect(strict.acceptance.status).toBe('refused');
  expect(strict.acceptance.findings).toContainEqual(exported.acceptance.findings.find(f => f.kind === 'new-collision')!);
}, 10000);

nativeTest('attributes a correction when independent paint order differs from reading order', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const ctx = doc.context;
  const font = ctx.register(ctx.obj({
    Type: 'Font', Subtype: 'Type1', BaseFont: 'Courier-Bold', Encoding: 'WinAnsiEncoding',
    FirstChar: 32, LastChar: 126, Widths: Array(95).fill(600),
    ToUnicode: ctx.register(ctx.flateStream('1 beginbfrange <20> <7e> <0020> endbfrange')),
  }));
  page.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: font } }));
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(
    'BT /F1 20 Tf 1 0 0 1 92 120 Tm (B) Tj 1 0 0 1 80 120 Tm (A) Tj ET',
  )));
  const rect = { x: 79.8, y: 116, w: 24.4, h: 19 };
  const value = overlay({ originalText: 'AB', text: 'AC', rect, coverRects: [rect], sourceBaselinesPt: [120],
    fontSize: 20, bold: true, sourceGlyphs: [
      { text: 'A', x: 80, y: 120, advance: 12 }, { text: 'B', x: 92, y: 120, advance: 12 },
    ] });
  const result = await buildContentTextPreview(await doc.save(), model([]).pages[0]!, [value], undefined, raster);
  expect(result.bytes).toBeTruthy();
  expect(result.outcomes[0]?.contact).toEqual({ kind: 'clear' });
}, 10000);
