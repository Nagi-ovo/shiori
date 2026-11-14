// Deliberately bypass the compiler to prove native evidence rejects bad output.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { PDFDocument, PDFDict, PDFName } from 'pdf-lib';
import { coverageFixtures } from '../font-coverage/fixtures';
import { tinyTtf } from '../../src/pdf/export/fontCoverage/fixtures/programs';
import { readSavedGlyphs } from './oracleGlyphs';
import { openPdfium } from './nativePdfium';
import { assertReplacementGlyphs } from './glyphEvidence';
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
      const specs = saved.glyphs.map(g => ({ ...g, replacement: g.unicode === 'd' }));
      const measured = native.measure(path, specs, saved.fontHashes);
      let refusal = '';
      try { assertReplacementGlyphs(measured.glyphs); } catch (error) { refusal = String(error); }
      assert(refusal.includes('absent/blank'), `native oracle accepted ${kind}`);
      rows.push({ kind, PDFiumText: measured.text, evidence: measured.glyphs.filter(g => g.replacement), refused: true, reason: refusal });
    }
  } finally { native.close(); }
  await Bun.write(`${dir}/oracle-selfcheck.json`, JSON.stringify({ command: 'bun scripts/pdf-inplace/surgical-first.ts', cases: rows }, null, 2));
  console.log(JSON.stringify(rows));

}
