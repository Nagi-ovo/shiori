// Deliberately bypass the compiler to prove native evidence rejects bad output.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { PDFDocument, PDFDict, PDFName } from 'pdf-lib';
import { coverageFixtures } from '../font-coverage/fixtures';
import { tinyTtf } from '../../src/pdf/export/fontCoverage/fixtures/programs';
import { readSavedGlyphs } from './oracleGlyphs';
import { openPdfium } from './nativePdfium';
import { assertReplacementGlyphs, GlyphEvidenceError } from './glyphEvidence';
export async function checkNativeEvidence(library: string, dir: string) {
  const native = openPdfium(library);
  const rows = [];
  try {
    for (const kind of ['notdef', 'empty-glyf']) {
      const doc = await PDFDocument.load((await coverageFixtures()).get('subset')!);
      if (kind === 'empty-glyf') {
        const font = doc.getPage(0).node.Resources()!.lookup(PDFName.of('Font'), PDFDict).lookup(PDFName.of('F1'), PDFDict);
        font.lookup(PDFName.of('FontDescriptor'), PDFDict).set(PDFName.of('FontFile2'), doc.context.register(doc.context.flateStream(tinyTtf({ maps: [{ platform: 3, encoding: 1, entries: [[83, 1], [97, 2], [110, 3], [100, 7]] }], empty: [7] }))));
      }
      const bytes = await doc.save({ useObjectStreams: false });
      const path = join(dir, `oracle-selfcheck-${kind}.pdf`);
      await Bun.write(path, bytes);
      const saved = await readSavedGlyphs(bytes);
      const specs = saved.glyphs.map(g => ({ ...g, glyphId: g.unicode === 'd' ? 7 : g.glyphId, replacement: g.unicode === 'd' }));
      const measured = await native.measure(path, specs, saved.fontHashes);
      const evidence = measured.glyphs.filter(g => g.replacement);
      const target = evidence[0]!;
      assert.equal(target.glyphId, 7, 'self-check must forge a positive coverage GID');
      if (kind === 'notdef') {
        assert(target.pathSegments! > 0 && target.inkPixels! > 0, 'inked .notdef preconditions missing');
      } else {
        assert.equal(target.pathSegments, 0, 'empty-glyf must have no native outline');
        assert.equal(target.inkPixels, 0, 'empty-glyf must be blank');
      }
      let refusal: unknown;
      try { assertReplacementGlyphs(measured.glyphs); } catch (error) { refusal = error; }
      assert(refusal instanceof GlyphEvidenceError, `native oracle accepted ${kind}`);
      const expectedCode = kind === 'notdef' ? 'native-notdef-match' : 'blank-native-glyph';
      assert.equal(refusal.code, expectedCode, `wrong native self-check failure: ${kind}`);
      rows.push({ kind, PDFiumText: measured.text, evidence, refused: true, reasonCode: refusal.code, reason: refusal.message });
    }
  } finally { native.close(); }
  await Bun.write(`${dir}/oracle-selfcheck.json`, JSON.stringify({ command: 'bun scripts/pdf-inplace/surgical-first.ts', cases: rows }, null, 2));
  console.log(JSON.stringify(rows));

}
