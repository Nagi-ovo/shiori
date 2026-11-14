import { expect, test } from 'bun:test';
import { PDFDocument, PDFName, PDFArray, PDFDict } from 'pdf-lib';
import { inspectRunPage, replaceRunPage } from './replaceRunPage';

const bytes = (s: string) => new TextEncoder().encode(s);
async function fixture(cmap = '1 beginbfrange <20> <7e> <0020> endbfrange', subtype = 'TrueType') {
  const doc = await PDFDocument.create();
  const page = doc.addPage();
  const f = (mapping: string) => doc.context.register(doc.context.obj({
    Type: 'Font', Subtype: subtype, BaseFont: 'AAAAAA+Same', FirstChar: 32,
    Widths: Array(95).fill(500), ToUnicode: doc.context.register(doc.context.stream(bytes(mapping))),
  }));
  const f1 = f(cmap), f2 = f('1 beginbfchar <41> <005a> endbfchar');
  page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F1: f1, F2: f2 } }));
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(bytes('BT /F1 10 Tf (AB) Tj /F2 10 Tf (A) Tj ET'))));
  const info = inspectRunPage(page);
  if (!info.ok) throw Error(info.reason);
  const edit = { fontResource: 'F1', fontObject: f1.toString(), opIndex: 2, itemIndex: -1,
    byteStart: 0, byteEnd: 2, expected: bytes('AB'), replacement: 'BA' };
  return { doc, page, info, edit, f1, f2 };
}
test('same BaseFont keeps resource/object encodings distinct and shared streams copy on write', async () => {
  const { doc, page, info, edit, f2 } = await fixture();
  const duplicate = doc.addPage();
  const original = page.node.get(PDFName.of('Contents'));
  duplicate.node.set(PDFName.of('Contents'), original!);
  duplicate.node.set(PDFName.of('Resources'), page.node.get(PDFName.of('Resources'))!);
  const result = replaceRunPage(page, { sourceHash: info.sourceHash, edits: [edit] });
  expect(result.ok).toBe(true);
  expect(duplicate.node.get(PDFName.of('Contents'))).toBe(original);
  expect(page.node.Resources()!.lookup(PDFName.of('Font'), PDFDict).get(PDFName.of('F2'))).toEqual(f2);
  const updated = inspectRunPage(page);
  expect(updated.ok).toBe(true);
  if (updated.ok) expect(new TextDecoder().decode(updated.bytes)).toContain('/F2 10 Tf (A) Tj');
  const second = replaceRunPage(duplicate, { sourceHash: info.sourceHash, edits: [{ ...edit, fontResource: 'F2', fontObject: f2.toString(), opIndex: 4, byteEnd: 1, expected: bytes('A'), replacement: 'B' }] });
  expect(second.ok).toBe(false);
  expect(duplicate.node.get(PDFName.of('Contents'))).toBe(original);
});
for (const cmap of ['', '1 beginbfchar <41> <ZZZZ> endbfchar', '2 beginbfchar <41> <0041> endbfchar', '1 beginbfrange <41> <42> [<0041>] endbfrange']) {
  test(`malformed/missing ToUnicode refuses atomically: ${cmap}`, async () => {
    const { page, info, edit } = await fixture(cmap);
    const original = page.node.get(PDFName.of('Contents'));
    const result = replaceRunPage(page, { sourceHash: info.sourceHash, edits: [edit] });
    expect(result.ok).toBe(false);
    expect(page.node.get(PDFName.of('Contents'))).toBe(original);
  });
}
test('Type3 and vertical fonts refuse', async () => {
  const { page, info, edit, doc, f1 } = await fixture(undefined, 'Type3');
  expect(replaceRunPage(page, { sourceHash: info.sourceHash, edits: [edit] }).ok).toBe(false);
  const font = doc.context.lookup(f1, PDFDict);
  font.set(PDFName.of('Subtype'), PDFName.of('Type0'));
  font.set(PDFName.of('Encoding'), PDFName.of('Identity-V'));
  font.set(PDFName.of('DescendantFonts'), doc.context.obj([]) as PDFArray);
  expect(replaceRunPage(page, { sourceHash: info.sourceHash, edits: [edit] }).ok).toBe(false);
});
test('failed later edit leaves page stream and context unchanged', async () => {
  const { page, info, edit, doc } = await fixture();
  const original = page.node.get(PDFName.of('Contents'));
  const count = doc.context.enumerateIndirectObjects().length;
  const result = replaceRunPage(page, { sourceHash: info.sourceHash, edits: [edit, { ...edit, opIndex: 99 }] });
  expect(result.ok).toBe(false);
  expect(page.node.get(PDFName.of('Contents'))).toBe(original);
  expect(doc.context.enumerateIndirectObjects().length).toBe(count);
});
