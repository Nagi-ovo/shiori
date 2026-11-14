import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { coverageFixtures } from '../font-coverage/fixtures';
import { tinyTtf } from '../../src/pdf/export/fontCoverage/fixtures/programs';
import { inspectRunPage, replaceRunPage } from '../../src/pdf/export/contentStreamEdit/replaceRunPage';

export async function negativeCases(out: string) {
  const fixtures = await coverageFixtures(), cases = [];
  for (const name of ['missing-notdef', 'missing-glyf', 'raw-type1']) {
    const doc = await PDFDocument.load(fixtures.get('subset')!, { updateMetadata: false });
    const page = doc.getPage(0), ctx = doc.context;
    const fonts = page.node.Resources()!.lookup(PDFName.of('Font'), PDFDict);
    const fontRef = fonts.get(PDFName.of('F1'))!;
    const font = fonts.lookup(PDFName.of('F1'), PDFDict);
    const descriptor = font.lookup(PDFName.of('FontDescriptor'), PDFDict);
    if (name === 'missing-glyf') descriptor.set(PDFName.of('FontFile2'), ctx.register(ctx.flateStream(tinyTtf({
      maps: [{ platform: 3, encoding: 1, entries: [[83, 1], [97, 2], [110, 3], [100, 7]] }], empty: [7],
    }))));
    if (name === 'raw-type1') {
      font.set(PDFName.of('Subtype'), PDFName.of('Type1'));
      descriptor.delete(PDFName.of('FontFile2'));
      descriptor.set(PDFName.of('FontFile'), ctx.register(ctx.flateStream('%!PS-AdobeFont-1.0: Tiny 1.0\n/FontName /Tiny def')));
    }
    // d is advertised by ToUnicode/Encoding but never shown in the original.
    page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream('BT /F1 12 Tf 20 100 Td <53616e> Tj ET')));
    const source = inspectRunPage(page);
    if (!source.ok) throw Error(source.reason);
    const before = await doc.save({ useObjectStreams: false });
    const contents = page.node.get(PDFName.of('Contents')), objects = ctx.enumerateIndirectObjects().length;
    const result = replaceRunPage(page, { sourceHash: source.sourceHash, edits: [{
      fontResource: 'F1', fontObject: fontRef.toString(), opIndex: 3, itemIndex: -1,
      byteStart: 0, byteEnd: 3, expected: Uint8Array.of(83, 97, 110), replacement: 'Sand',
    }] });
    const expected = name === 'raw-type1' ? ['S', 0] : ['d', 3];
    if (result.ok || result.firstMissing !== expected[0] || result.offset !== expected[1]) throw Error(`incorrect refusal: ${name}: ${JSON.stringify(result)}`);
    if (page.node.get(PDFName.of('Contents')) !== contents || ctx.enumerateIndirectObjects().length !== objects) throw Error(`refusal mutated context: ${name}`);
    const after = await doc.save({ useObjectStreams: false });
    if (!Buffer.from(before).equals(Buffer.from(after))) throw Error(`refusal changed bytes: ${name}`);
    // Re-parse saved fonts/codes as well as checking full byte equality.
    const reopened = await PDFDocument.load(after, { updateMetadata: false });
    const saved = inspectRunPage(reopened.getPage(0));
    if (!saved.ok || !Buffer.from(saved.bytes).equals(Buffer.from(source.bytes))) throw Error(`saved refusal changed content: ${name}`);
    const beforeName = `${name}.before.pdf`, afterName = `${name}.after.pdf`;
    await writeFile(join(out, beforeName), before);
    await writeFile(join(out, afterName), after);
    cases.push({ name, before: beforeName, after: afterName, refused: true, sourceText: 'San',
      reason: result.reason, firstMissing: result.firstMissing, offset: result.offset, unchangedBytes: true });
  }
  return cases;
}
