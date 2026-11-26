import { expect, test } from 'bun:test';
import fontkit from '@pdf-lib/fontkit';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { readSavedGlyphs } from '../../../../scripts/pdf-inplace/oracleGlyphs';
import { prepareFallback } from '../contentStreamEdit/fallbackFont';
import { hex } from '../contentStreamEdit/runEncoding';
import { resolveFont, type LocalFont } from '../fonts/fontService';
import { sourceFontReader } from '../fonts/sourceFontContext';
import type { ContentTextOutcome } from './outcomes';
import { applyUprightColumnRetypesets } from './uprightColumn';
import { columnEdit, loadFont, pageColumns } from './uprightColumn.fixture.test';

// A matching restricted font must yield the same searchable replacement and
// embedded programs as the bundled coverage chain, including the source subset.
test('an embedding denial leaves upright bundled glyph fallback available', async () => {
  const originalText = '日本語';
  const replacementText = '日调語';
  const replacementCodePoint = '调'.codePointAt(0)!;
  const japaneseFace = 'NotoSansJP-Regular.otf';
  const simplifiedFace = 'NotoSansSC-Regular.otf';
  const name = PDFName.of;
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const source = await prepareFallback(doc, 'F1', japaneseFace, Array.from(originalText), { loadFont });
  const font = doc.context.lookup(source.ref, PDFDict);
  font.set(name('BaseFont'), name('NotoSansSC-Regular'));
  const descendant = font.lookup(name('DescendantFonts'), PDFArray).lookup(0, PDFDict);
  descendant.lookup(name('CIDSystemInfo'), PDFDict).set(name('Ordering'), PDFString.of('Japan1'));
  page.node.set(name('Resources'), doc.context.obj({ Font: { F1: source.ref } }));
  const shows = Array.from(originalText, character => {
    const code = source.resolved.canEncode!(character);
    if (!code.ok) throw Error(code.reason);
    return `${hex(code.bytes)} Tj`;
  });
  page.node.set(name('Contents'), doc.context.register(doc.context.stream(
    `BT /F1 16 Tf 150 150 Td ${shows.join(' 0 -16 Td ')} ET`,
  )));

  const restrictedBytes = await loadFont(simplifiedFace);
  const local = fontkit.create(restrictedBytes);
  expect(local.glyphForCodePoint(replacementCodePoint).id).toBeGreaterThan(0);
  expect(fontkit.create(await loadFont(japaneseFace)).glyphForCodePoint(replacementCodePoint).id).toBe(0);
  const os2 = local.directory.tables['OS/2']!;
  new DataView(restrictedBytes.buffer, restrictedBytes.byteOffset, restrictedBytes.byteLength).setUint16(os2.offset + 8, 2);
  const localFonts = [{ name: 'restricted-local.otf', bytes: restrictedBytes }];
  expect(resolveFont({
    ...sourceFontReader(page, [])('F1', 0), purpose: 'vertical', text: '调',
  }, { localFonts })).toMatchObject({
    name: japaneseFace, source: 'bundled', region: 'JP', reason: 'local-permission-denied',
  });

  const before = await doc.save();
  const original = await readSavedGlyphs(before);
  const write = async (locals?: readonly LocalFont[]) => {
    const copy = await PDFDocument.load(before, { updateMetadata: false });
    const target = copy.getPage(0);
    const { columns, box } = pageColumns(target);
    const edit = columnEdit(columns[0]!, box, () => replacementText);
    const outcomes = new Map<string, ContentTextOutcome>();
    await applyUprightColumnRetypesets(target, [edit], outcomes, new Set(), { loadFont, localFonts: locals });
    expect(outcomes.get(edit.id)).toMatchObject({
      mode: 'retypeset', retypeset: { substituteFont: simplifiedFace },
    });
    return readSavedGlyphs(await copy.save());
  };

  const bundled = await write();
  const withDeniedLocal = await write(localFonts);
  expect(withDeniedLocal).toEqual(bundled);
  expect(withDeniedLocal.glyphs.map(glyph => glyph.unicode).join('')).toBe(replacementText);
  expect(withDeniedLocal.glyphs.every(glyph => glyph.glyphId! > 0)).toBe(true);
  for (const index of [0, 2]) {
    const savedGlyph = withDeniedLocal.glyphs[index]!;
    const sourceGlyph = original.glyphs[index]!;
    expect(withDeniedLocal.fontHashes[savedGlyph.fontObject]).toBe(original.fontHashes[sourceGlyph.fontObject]!);
  }
  const replacementFont = withDeniedLocal.glyphs[1]!.fontObject;
  expect(withDeniedLocal.fontHashes[replacementFont]).not.toBe(original.fontHashes[original.glyphs[1]!.fontObject]);
});
