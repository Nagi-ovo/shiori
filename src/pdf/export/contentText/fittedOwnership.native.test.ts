import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import fontkit from '@pdf-lib/fontkit';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import { openPdfium } from '../../../../scripts/pdf-inplace/nativePdfium';
import { exportPdf } from '../exportPdf';
import { overlay } from './fixtures.test-support';

const library = 'vendor/pdfium/linux-x64/lib/libpdfium.so';
const size = 18.4164;

const cases = [
  { family: 'list', from: 'CHEKLIST', to: 'CHECKLIST', x: 65, y: 220,
    neighbors: [['01', 32, 220], ['02', 32, 192], ['SUMMARY', 65, 192]] },
  { family: 'indent', from: 'BRIEFNG', to: 'BRIEFING', x: 104, y: 222,
    neighbors: [['APPENDIX', 63, 255], ['TIMELINE NOTES', 63, 200]] },
  { family: 'table', from: 'SUPLIES', to: 'SUPPLIES', x: 36, y: 205,
    neighbors: [['APRIL', 176, 205], ['4,100', 260, 205], ['SHIPPING', 36, 178], ['MAY', 176, 178], ['375', 260, 178]], divider: true },
  { family: 'columns', from: 'CAPTIONNG', to: 'CAPTIONING', x: 28, y: 168,
    neighbors: [['INVENTORY', 248, 168], ['DRAFT COPY', 28, 192], ['LOCATION', 248, 144], ['EDIT TRACK', 28, 144]], divider: true },
  { family: 'caption', from: 'ZONNG', to: 'ZONING', x: 165, y: 82,
    neighbors: [['FIG 4', 120, 82], ['1996', 253, 82], ['PLATE DETAILS', 165, 60]], illustration: true },
] as const;

async function fixture(spec: typeof cases[number]) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(readFileSync('node_modules/@docx-editor.dev/fonts/assets/LiberationSans-Regular.ttf'));
  const page = doc.addPage([400, 300]), ctx = doc.context, name = PDFName.of;
  const image = ctx.register(ctx.flateStream(Uint8Array.of(216, 30, 30, 216), {
    Type: 'XObject', Subtype: 'Image', Width: 2, Height: 2, ColorSpace: 'DeviceGray', BitsPerComponent: 8,
  }));
  page.node.set(name('Resources'), ctx.obj({ Font: { F1: font.ref }, XObject: { Art: image } }));
  const commands = [
    ...('illustration' in spec ? ['q 95 0 0 46 164 114 cm /Art Do Q'] : []),
    ...spec.neighbors.map(([text, x, y]) => `BT /F1 9 Tf 1 0 0 1 ${x} ${y} Tm ${font.encodeText(text)} Tj ET`),
    `BT /F1 1 Tf .18 Tc ${size} 0 0 ${size} ${spec.x} ${spec.y} Tm ${font.encodeText(spec.from)} Tj ET`,
    ...('divider' in spec ? ['.7 G 1 w 155 123 m 155 233 l S'] : []),
  ];
  page.node.set(name('Contents'), ctx.register(ctx.flateStream(commands.join('\n'))));
  const saved = await PDFDocument.load(await doc.save());
  const widths = saved.context.lookup(font.ref, PDFDict).lookup(name('DescendantFonts'), PDFArray).lookup(0, PDFDict).lookup(name('W'), PDFArray);
  for (const row of widths.asArray()) {
    if (row instanceof PDFArray) row.asArray().forEach((width, i) => row.set(i, PDFNumber.of(Math.trunc((width as PDFNumber).asNumber()))));
  }
  return saved.save();
}

for (const spec of cases) test.skipIf(!existsSync(library))(`fits a tracked ${spec.family} correction without moving neighboring glyphs`, async () => {
  const source = await fixture(spec);
  const native = openPdfium(library);
  try {
    const before = native.inspectPage(source, 0, true);
    const owned = before.glyphs.filter(g => g.fontSize > 17 && g.origin[1] === spec.y);
    const edge = (glyphs: typeof owned) => Math.max(...glyphs.map(g => g.inkBox[2]));
    const rect = { x: spec.x - .15, y: spec.y - 4, w: edge(owned) - spec.x + .35, h: 22 };
    const edit = overlay({ fontFamily: 'sans', fontSize: 18.42, originalText: spec.from, text: spec.to,
      rect, coverRects: [rect], sourceBaselinesPt: [spec.y],
      sourceGlyphs: owned.map(g => ({ text: g.text, x: g.origin[0], y: g.origin[1], advance: g.box[2] - g.origin[0] })),
    });
    const model = { pages: [{ id: 'p', sourceIndex: 0, widthPt: 400, heightPt: 300, rotation: 0 }], overlays: [edit] };
    const saved = await exportPdf(source, model, { mode: 'annotations' });
    const after = native.inspectPage(saved.bytes, 0, true);
    const signature = (g: typeof owned[number]) => [g.text, g.origin, g.inkBox, g.fontSize, g.fontHash];
    const stationary = (glyphs: typeof owned) => glyphs.filter(g => g.fontSize < 15).map(signature);
    expect(stationary(after.glyphs)).toEqual(stationary(before.glyphs));
    expect(saved.contentTextOutcomes?.[0]).toMatchObject({ mode: 'in-place', fidelity: 'approximate', sourceSpacingAdjusted: true });
    const title = after.glyphs.filter(g => g.fontSize > 17);
    expect(new Set(title.map(g => g.origin[1]))).toEqual(new Set([spec.y]));
    expect(title.map(g => g.text).join('')).toBe(spec.to);
    expect(Math.max(...title.map(g => Math.abs(g.fontSize - size)))).toBeLessThanOrEqual(.01);
    expect(after.text).toContain(spec.to);
    expect(Math.abs(edge(title) - edge(owned))).toBeLessThan(.1);
    if (Bun.which('pdftotext')) {
      const poppler = Bun.spawnSync(['pdftotext', '-layout', '-', '-'], { stdin: saved.bytes });
      expect(poppler.exitCode).toBe(0);
      expect(poppler.stdout.toString()).toContain(spec.to);
    }
  } finally {
    native.close();
  }
});
