import { expect, test } from 'bun:test';
import { PDFDocument, PDFName } from 'pdf-lib';
import { assertSavedGlyphs, readSavedGlyphs } from './oracleGlyphs';

async function fixture() {
  const doc = await PDFDocument.create();
  const page = doc.addPage();
  const program = doc.context.register(doc.context.stream(new Uint8Array([1, 2, 3])));
  const descriptor = doc.context.register(doc.context.obj({ FontFile2: program }));
  const cmap = doc.context.register(doc.context.stream(new TextEncoder().encode('2 beginbfchar <41> <0041> <42> <0041> endbfchar')));
  const createFont = () => doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'TrueType',
    BaseFont: 'Same', FirstChar: 65, Widths: [500, 500], ToUnicode: cmap, FontDescriptor: descriptor }));
  const f1 = createFont(), f2 = createFont();
  page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F1: f1, F2: f2 } }));
  async function save(font: string, code: string) {
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(new TextEncoder().encode(`BT /${font} 10 Tf <${code}> Tj ET`))));
    return readSavedGlyphs(await doc.save({ useObjectStreams: false }));
  }
  return { save, f1, f2 };
}
test('saved-output oracle rejects a changed code with identical Unicode and width', async () => {
  const { save } = await fixture();
  const before = await save('F1', '41'), after = await save('F1', '42');
  expect(before.glyphs[0]!.unicode).toBe(after.glyphs[0]!.unicode);
  expect(before.glyphs[0]!.code).toBe(65);
  expect(after.glyphs[0]!.code).toBe(66);
  expect(() => assertSavedGlyphs(before.glyphs, after.glyphs)).toThrow();
});
test('saved-output oracle rejects a font-object swap with identical code/Unicode/program', async () => {
  const { save, f1, f2 } = await fixture();
  const before = await save('F1', '41'), after = await save('F2', '41');
  expect(before.glyphs[0]!.fontObject).toBe(f1.toString());
  expect(after.glyphs[0]!.fontObject).toBe(f2.toString());
  expect(() => assertSavedGlyphs(before.glyphs, after.glyphs)).toThrow();
});
test('saved-output oracle accounts for every code and accepts an unchanged sequence', async () => {
  const { save } = await fixture();
  const { glyphs } = await save('F1', '41');
  expect(() => assertSavedGlyphs(glyphs, glyphs.map(g => ({ ...g })))).not.toThrow();
  expect(() => assertSavedGlyphs(glyphs, [])).toThrow();
});
