import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkNativeEvidence } from './checkNativeEvidence';
import { openPdfium } from './nativePdfium';
import { readSavedGlyphs } from './oracleGlyphs';
const library = join(process.env.SHIORI_PDFIUM_DIR ?? resolve('vendor/pdfium/linux-x64/lib'), 'libpdfium.so');
const nativeTest = test.skipIf(process.platform !== 'linux' || process.arch !== 'x64' || !existsSync(library));
nativeTest('native self-check rejects an inked .notdef with forged positive GID for the specific native reason', async () => {
  const out = await mkdtemp(join(tmpdir(), 'shiori-notdef-'));
  try {
    await checkNativeEvidence(library, out);
    const report = JSON.parse(await readFile(join(out, 'oracle-selfcheck.json'), 'utf8'));
    const missing = report.cases.find((c: { kind: string }) => c.kind === 'notdef');
    expect(missing.reasonCode).toBe('native-notdef-match');
    expect(missing.evidence[0]).toMatchObject({ glyphId: 7 });
    expect(missing.evidence[0].pathSegments).toBeGreaterThan(0);
    expect(missing.evidence[0].inkPixels).toBeGreaterThan(0);
    const blank = report.cases.find((c: { kind: string }) => c.kind === 'empty-glyf');
    expect(blank.reasonCode).toBe('blank-native-glyph');
  } finally { await rm(out, { recursive: true, force: true }); }
});
nativeTest('CID PDF code 1 queries Unicode L: seven native outline segments, not the ten-segment .notdef box', async () => {
  const out = await mkdtemp(join(tmpdir(), 'shiori-unicode-path-'));
  const native = openPdfium(library);
  try {
    const bytes = await readFile(new URL('./fixtures/subset.pdf', import.meta.url));
    const path = join(out, 'subset.pdf'); await writeFile(path, bytes);
    const saved = await readSavedGlyphs(bytes);
    const measured = await native.measure(path, saved.glyphs, saved.fontHashes);
    const first = measured.glyphs[0]!;
    expect(first.code).toBe(1); expect(first.unicode).toBe('L');
    expect(first.pathSegments).toBe(7);
    expect(first.nativePath?.[0]).toMatchObject({ type: 2, point: [0.08203125, 0], closed: false });
    expect(first.notdefProbes?.[0]?.path?.length).toBe(10);
  } finally { native.close(); await rm(out, { recursive: true, force: true }); }
});
