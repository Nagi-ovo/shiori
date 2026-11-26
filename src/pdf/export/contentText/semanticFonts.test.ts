import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFString } from 'pdf-lib';
import { readSavedGlyphs } from '../../../../scripts/pdf-inplace/oracleGlyphs';
import { buildContentTextPreview } from '../../../editor/components/contentTextPreview';
import { prepareFallback } from '../contentStreamEdit/fallbackFont';
import { hex } from '../contentStreamEdit/runEncoding';
import { exportPdf, type ExportOptions } from '../exportPdf';
import { fixture, model, overlay } from './fixtures.test-support';

const name = PDFName.of;
const loadFont = (file: string) => readFile(file.endsWith('.otf')
  ? `src/assets/fonts/${file}` : `node_modules/@docx-editor.dev/fonts/assets/${file}`);

async function taggedSource(property: 'inline' | 'named', equivalent = false) {
  const props = property === 'inline' ? '<< /MCID 0 /Lang <6a61> >>' : '/Label';
  const { doc, page } = await fixture();
  const ctx = doc.context;
  const embedded = await prepareFallback(doc, 'F1', 'LiberationMono-Regular.ttf', Array.from('ABCDE'), { loadFont });
  const encoded = embedded.resolved.canEncode!('ABCDE');
  if (!encoded.ok) throw Error(encoded.reason);
  page.node.set(name('Resources'), ctx.obj({ Font: { F1: embedded.ref } }));
  page.node.set(name('Contents'), ctx.register(ctx.stream(
    `/Span ${props} BDC BT /F1 10 Tf 50 100 Td ${hex(encoded.bytes)} Tj ET EMC`,
  )));
  if (property === 'named') {
    page.node.Resources()!.set(name('Properties'), ctx.obj({
      Label: { MCID: 0, Lang: PDFString.of('ko'), ...(equivalent && { ActualText: PDFString.of('ABCDE') }) },
    }));
  }
  page.node.set(name('StructParents'), ctx.obj(0));
  doc.catalog.set(name('Lang'), PDFString.of('zh-CN'));
  const root = ctx.nextRef();
  const owner = ctx.register(ctx.obj({ Type: 'StructElem', S: 'Span', P: root, Pg: page.ref, K: 0 }));
  ctx.assign(root, ctx.obj({ Type: 'StructTreeRoot', K: [owner], ParentTree: { Nums: [0, [owner]] } }));
  doc.catalog.set(name('StructTreeRoot'), root);
  return doc.save();
}

async function expectRegionalGlyph(bytes: Uint8Array, region: 'JP' | 'KR') {
  const saved = await readSavedGlyphs(bytes);
  expect(saved.glyphs.map(glyph => glyph.unicode).join('')).toBe('AB骨DE');
  const glyph = saved.glyphs[2]!;
  expect(glyph.glyphId).toBeGreaterThan(0);
  const pdf = await PDFDocument.load(bytes);
  const font = pdf.context.enumerateIndirectObjects().find(([ref]) => ref.toString() === glyph.fontObject)?.[1] as PDFDict;
  const program = (font: PDFDict) => decodePDFRawStream(font.lookup(name('DescendantFonts'), PDFArray)
    .lookup(0, PDFDict).lookup(name('FontDescriptor'), PDFDict).lookup(name('FontFile3'), PDFRawStream)).decode();
  const scratch = await PDFDocument.create();
  const expected = await prepareFallback(scratch, 'Expected', `NotoSans${region}-Regular.otf`, ['骨'], { loadFont });
  expect(program(font)).toEqual(program(scratch.context.lookup(expected.ref, PDFDict)));
  const root = pdf.catalog.lookupMaybe(name('StructTreeRoot'), PDFDict);
  expect(root).toBeDefined();
  const owner = root!.lookup(name('K'), PDFArray).get(0);
  const parents = root!.lookup(name('ParentTree'), PDFDict).lookup(name('Nums'), PDFArray);
  expect(parents.lookup(1, PDFArray).get(0)).toBe(owner);
}

// The mark's byte spans, font language and owner all survive the same write.
// A partial equivalent must refuse before a font loader can affect the verdict.
test.each([['inline', 'JP'], ['named', 'KR']] as const)(
  'saved tagged edit and preview use the regional face from %s properties',
  async (property, region) => {
    const source = await taggedSource(property);
    const edit = overlay({ text: 'AB骨DE' });
    const document = model([edit]);
    const options: ExportOptions = {
      mode: 'flatten', stage5Reflow: false, acceptance: 'strict',
      inPlaceFallback: { loadFont },
    };
    const result = await exportPdf(source, document, options);
    expect(result.contentTextOutcomes).toMatchObject([{
      mode: 'retypeset', retypeset: { substituteFont: `NotoSans${region}-Regular.otf` },
    }]);
    await expectRegionalGlyph(result.bytes, region);
    expect(result.acceptance.status).toBe('accepted');
    expect(result.semanticChanges).toMatchObject([{
      overlayId: edit.id, action: 'preserved', dependency: { kind: 'mcid', mcid: 0, stream: 'page' },
    }]);

    const preview = await buildContentTextPreview(source, document.pages[0]!, [edit], undefined, undefined, options);
    expect(preview.outcomes).toEqual(result.contentTextOutcomes!);
    expect(preview.semanticChanges).toEqual(result.semanticChanges!);
    expect(preview.acceptance).toMatchObject({ status: 'accepted', findings: [] });
    await expectRegionalGlyph(preview.bytes!, region);
  },
);

test('a partial tagged equivalent refuses before regional font resolution', async () => {
  const source = await taggedSource('named', true);
  const edit = overlay({
    originalText: 'C', text: '骨', coverRects: [{ x: 61.9, y: 98, w: 6.2, h: 13 }],
  });
  const document = model([edit]);
  const requests: string[] = [];
  const options: ExportOptions = {
    mode: 'flatten', stage5Reflow: false, acceptance: 'strict',
    inPlaceFallback: { loadFont: async file => {
      requests.push(file);
      throw Error('font unavailable');
    } },
  };
  const result = await exportPdf(source, document, options);
  expect(result.contentTextOutcomes).toMatchObject([{ mode: 'unsupported', reason: 'semantic-dependency' }]);
  expect(result.semanticChanges).toContainEqual(expect.objectContaining({
    action: 'refused', reason: 'semantic-replacement-text',
    dependency: expect.objectContaining({ kind: 'actual-text', text: 'ABCDE' }),
  }));
  expect(result.bytes).toEqual(source);
  const preview = await buildContentTextPreview(source, document.pages[0]!, [edit], undefined, undefined, options);
  expect(preview.bytes).toBeNull();
  expect(preview.outcomes).toEqual(result.contentTextOutcomes!);
  expect(preview.semanticChanges).toEqual(result.semanticChanges!);
  expect(result.acceptance.status).toBe('refused');
  expect(preview.acceptance).toMatchObject({ status: 'refused', findings: result.acceptance.findings });
  expect(requests).toEqual([]);
});
