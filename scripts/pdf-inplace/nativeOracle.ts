// Rerun through surgical-first.ts; native PDFium reader/raster only.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openPdfium } from './nativePdfium';
import { assertReplacementGlyphs } from './glyphEvidence';
import { assertSavedGlyphs, type OracleGlyph } from './oracleGlyphs';

type Positive = { name: string; before: string; after: string; refused?: false;
  beforeGlyphs: OracleGlyph[]; afterGlyphs: OracleGlyph[]; expectedAfterGlyphs: OracleGlyph[];
  fontHashes: Record<string, string>; editBox: [number, number, number, number]; required: string[]; absent: string[]; embeddedFallback?: boolean; expectedText?: string; originChecks?: { beforeIndex:number; afterIndex:number; deltaPt:number }[] };
type Negative = { name: string; before: string; after: string; refused: true; sourceText: string;
  reason: string; firstMissing: string; offset: number };
function command(name: string, args: string[]) {
  const result = spawnSync(name, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, `${name}: ${result.error ?? ''}${result.stdout}${result.stderr}`);
  return result.stdout;
}
export async function nativeOracle(library: string, out: string, preview = false) {
  const native = openPdfium(library);
  try {
    if (preview) {
      const checks = ['preview-300.before.pdf', 'preview-300.full.pdf', 'preview-300.incremental.pdf'].map(file => {
        const texts = [0, 299].map(index => {
          const result = native.textAt(join(out, file), index);
          assert.equal(result.pages, 300);
          assert(result.text.includes(index === 299 || file.includes('before') ? 'Hello World' : 'Hello'));
          if (index === 0 && !file.includes('before')) assert(!result.text.includes('Hello World'));
          return result.text;
        });
        return { file, pages: 300, firstAndLastText: texts, passed: true };
      });
      writeFileSync(join(out, 'preview-native.json'), JSON.stringify(checks, null, 2));
      console.log(JSON.stringify(checks));
      return;
    }
    const manifest: (Positive | Negative)[] = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    const rows: Record<string, unknown>[] = [];
    for (const c of manifest) {
      const beforePath = join(out, c.before), afterPath = join(out, c.after);
      if (c.refused) {
        assert(readFileSync(beforePath).equals(readFileSync(afterPath)), 'refusal changed saved bytes');
        const before = native.textAt(beforePath), after = native.textAt(afterPath);
        assert.equal(before.text, after.text); assert(after.text.includes(c.sourceText));
        command('qpdf', ['--check', afterPath]);
        const poppler = command('pdftotext', ['-layout', afterPath, '-']);
        assert(poppler.includes(c.sourceText));
        rows.push({ ...c, unchangedBytes: true, nativeReopened: true, PDFiumText: after.text, pdftotext: poppler, qpdf: 'clean', passed: true });
        console.log(JSON.stringify(rows.at(-1)));
        continue;
      }
      assertSavedGlyphs(c.expectedAfterGlyphs, c.afterGlyphs);
      const before = await native.measure(beforePath, c.beforeGlyphs, c.fontHashes);
      const after = await native.measure(afterPath, c.afterGlyphs, c.fontHashes);
      for (const check of c.originChecks ?? []) {
        const a=before.glyphs[check.beforeIndex]!,b=after.glyphs[check.afterIndex]!;
        assert(Math.abs(b.origin[0]!-a.origin[0]!-check.deltaPt)<=.01, `${c.name}: wrong Tw/width delta`);
      }
      const visibleReplacementGlyphs = assertReplacementGlyphs(after.glyphs);
      const old = before.glyphs.filter(g => !g.edited), current = after.glyphs.filter(g => !g.edited);
      assert.equal(old.length, current.length);
      let drift = 0;
      for (const [i, x] of old.entries()) {
        const y = current[i]!;
        assert.equal(x.fontObject, y.fontObject, `untouched font changed: ${c.name}/${i}`);
        assert.equal(x.code, y.code, `untouched code/order changed: ${c.name}/${i}`);
        drift = Math.max(drift, Math.hypot(x.origin[0]! - y.origin[0]!, x.origin[1]! - y.origin[1]!));
      }
      assert(drift <= .01, `neighbour drift ${drift}: ${c.name}`);
      assert.equal(before.pixels.length, after.pixels.length);
      let outside = 0, total = 0;
      const [left, bottom, right, top] = c.editBox;
      for (let i = 0; i < before.pixels.length; i += 4) {
        if (before.pixels.readUInt32LE(i) === after.pixels.readUInt32LE(i)) continue;
        total++;
        const x = (i / 4) % before.width, y = Math.floor(i / 4 / before.width);
        if (!(left * 2 <= x && x < right * 2 && before.height - top * 2 <= y && y < before.height - bottom * 2)) outside++;
      }
      assert.equal(outside, 0, `${c.name}: pixels outside declared box`);
      if (!before.glyphs.some(g => g.edited)) assert.equal(total, 0, `${c.name}: identity changed raster`);
      const poppler = command('pdftotext', ['-layout', afterPath, '-']);
      const normalized = (s:string) => s.replace(/\s+/gu,' ').trim();
      if (c.expectedText) { assert.equal(normalized(after.text),c.expectedText); assert.equal(normalized(poppler),c.expectedText); }
      for (const needle of c.required) assert(normalized(after.text).includes(needle) && normalized(poppler).includes(needle), `${c.name}: missing ${needle}`);
      for (const needle of c.absent) assert(!after.text.includes(needle) && !poppler.includes(needle), `${c.name}: old text active ${needle}`);
      command('qpdf', ['--check', afterPath]);
      const pdffonts = c.embeddedFallback ? command('pdffonts',[afterPath]) : undefined;
      if (pdffonts) assert(/ShioriFallback.*yes\s+yes\s+yes/.test(pdffonts), 'fallback must be embedded, subset and Unicode');
      writeFileSync(afterPath.replace(/\.pdf$/, '.txt'), poppler);
      const row = { name: c.name, sourceGlyphs: before.glyphs.length, editedSourceGlyphs: before.glyphs.length - old.length,
        untouchedGlyphs: old.length, outputGlyphs: after.glyphs.length, savedCodesVerified: true, maxOriginDriftPt: drift,
        changedPixels: total, changedPixelsOutsideBox: outside, editBox: c.editBox,
        originChecks:c.originChecks, pdffonts, visibleReplacementGlyphs, noBlankReplacementGlyphs: true, noNotdefReplacementGlyphs: true,
        fontObjects: Object.keys(c.fontHashes).sort(), PDFiumText: after.text, pdftotext: poppler, qpdf: 'clean', passed: true };
      // Raw rasters are PPM artifacts; JSON retains all native glyph evidence.
      const { pixels: beforePixels, ...beforeReport } = before;
      const { pixels: afterPixels, ...afterReport } = after;
      assert.equal(beforePixels.length, afterPixels.length);
      writeFileSync(join(out, `${c.name}.glyphs.json`), JSON.stringify({ before: beforeReport, after: afterReport }, null, 2));
      rows.push(row); console.log(JSON.stringify(row));
    }
    writeFileSync(join(out, 'report.json'), JSON.stringify({ nativeLibrary: resolve(library),
      glyphPathArgument: 'Unicode scalar', notdefDiscriminator: 'native path vs known-GID0 probe; coverage GID is an extra guard',
      raster: { dpi: 144, format: 'BGRA', flags: 0, channelTolerance: 0 }, cases: rows }, null, 2));
  } finally { native.close(); }
}
