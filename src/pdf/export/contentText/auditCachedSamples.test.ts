import { expect, test } from 'bun:test';
import { PDFDict, PDFDocument } from 'pdf-lib';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildCorpusOverlays } from '../../../../scripts/pdf-corpus/overlays';
import { fontInputFromDict } from '../fontCoverage/pdfLibAdapter';
import { exportPdf } from '../exportPdf';
import { inspectRunPage } from '../contentStreamEdit/replaceRunPage';
import type { ContentTextOutcome } from './outcomes';
import type { PageModel } from '../../model/types';

type Row = { id: string; page: number; kind: string; original: string; text: string; outcome: ContentTextOutcome };
const key = (r: Row) => `${r.id}/${r.page}/${r.kind}`;
// Optional seven-file regression replay, not the corpus runner. Reproduce with:
// SHIORI_AUDIT_CACHED=1 bun test src/pdf/export/contentText/auditCachedSamples.test.ts
test.skipIf(process.env.SHIORI_AUDIT_CACHED !== '1')('cached selections expose addressed Tr 2 and recover precise refusal reasons', async () => {
  const baselineRoot = resolve('../pdf-inplace-ui/test-artifacts/pdf-corpus');
  const baseline: { rows: Row[] } = JSON.parse(await readFile(resolve(baselineRoot, 'report.json'), 'utf8'));
  const prior: { rows: Row[] } = JSON.parse(await readFile('test-artifacts/pdf-corpus-default/report.json', 'utf8'));
  const old = new Map(baseline.rows.map(r => [key(r), r]));
  const affected = prior.rows.filter(r => r.outcome.reason === 'font-unavailable' && old.get(key(r))?.outcome.reason !== 'font-unavailable');
  expect(affected).toHaveLength(44);
  const { openPdfium } = await import('../../../../scripts/pdf-inplace/nativePdfium');
  const native = openPdfium(resolve('vendor/pdfium/linux-x64/lib/libpdfium.so'));
  const out = resolve('test-artifacts/audit'); await mkdir(out, { recursive: true });
  const sc = new Uint8Array(await readFile('src/assets/fonts/NotoSansSC-Regular.otf'));
  const jp = new Uint8Array(await readFile('src/assets/fonts/NotoSansJP-Regular.otf'));
  const results: { key: string; before: ContentTextOutcome; poisoned: ContentTextOutcome; after: ContentTextOutcome }[] = [];
  const inventory: { id: string; subtype: string; symbolic?: boolean; cmaps: { platform: number; encoding: number; format: number }[] }[] = [];
  const files = new Map<string, PDFDocument>();
  try {
    for (const id of new Set(affected.map(r => r.id))) {
      const doc = await PDFDocument.load(await readFile(resolve(baselineRoot, 'cache', `${id}.pdf`)), { ignoreEncryption: true }); files.set(id, doc);
      for (const [, value] of doc.context.enumerateIndirectObjects()) {
        if (!(value instanceof PDFDict)) continue;
        const f = fontInputFromDict(value); if (!['TrueType', 'Type3'].includes(f.subtype)) continue;
        const cmaps: { platform: number; encoding: number; format: number }[] = [], bytes = f.program;
        if (bytes && bytes.length >= 12) {
          const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          for (let i = 0; i < v.getUint16(4) && 12 + (i + 1) * 16 <= bytes.length; i++) {
            const p = 12 + i * 16; if (String.fromCharCode(...bytes.slice(p, p + 4)) !== 'cmap') continue;
            const offset = v.getUint32(p + 8), length = v.getUint32(p + 12); if (offset + length > bytes.length || length < 4) continue;
            for (let j = 0; j < v.getUint16(offset + 2) && 4 + (j + 1) * 8 <= length; j++) {
              const r = offset + 4 + j * 8, start = offset + v.getUint32(r + 4);
              if (start + 2 <= offset + length) cmaps.push({ platform: v.getUint16(r), encoding: v.getUint16(r + 2), format: v.getUint16(start) });
            }
          }
        }
        inventory.push({ id, subtype: f.subtype, symbolic: !!((f.flags ?? 0) & 4), cmaps });
      }
    }
    const pages = new Map<string, { bytes: Uint8Array; page: PageModel; overlays: ReturnType<typeof buildCorpusOverlays> }>();
    for (const row of affected) {
      const pageKey = `${row.id}/${row.page}`; let cached = pages.get(pageKey);
      if (!cached) {
        const single = await PDFDocument.create(), [copied] = await single.copyPages(files.get(row.id)!, [row.page]);
        const page = single.addPage(copied!), crop = page.getCropBox(), bytes = await single.save();
        const model: PageModel = { id: 'corpus-page', sourceIndex: 0, widthPt: crop.width, heightPt: crop.height, originXPt: crop.x, originYPt: crop.y, rotation: page.getRotation().angle as PageModel['rotation'] };
        cached = { bytes, page: model, overlays: buildCorpusOverlays(native.inspectPage(bytes), model) }; pages.set(pageKey, cached);
        if (row.id === 'gsa-1' || row.id === 'gsa-2') {
          const content = inspectRunPage(page);
          if (content.ok) await writeFile(resolve(out, `${row.id}-${row.page}.stream.txt`), content.bytes);
        }
      }
      const selection = cached.overlays.find(o => o.originalText === row.original);
      if (!selection) throw Error(`Cached native selection changed: ${key(row)}`);
      const result = await exportPdf(cached.bytes, { pages: [cached.page], overlays: [{ ...selection, text: row.text }] }, { mode: 'flatten', unicodeFontBytes: sc, unicodeJpFontBytes: jp,
        inPlaceFallback: { loadFont: name => readFile(name.endsWith('.ttf') ? `node_modules/@docx-editor.dev/fonts/assets/${name}` : `src/assets/fonts/${name}`) } });
      const after = result.contentTextOutcomes?.[0]; if (!after) throw Error(`Missing outcome: ${key(row)}`);
      results.push({ key: key(row), before: old.get(key(row))!.outcome, poisoned: row.outcome, after });
    }
    await writeFile(resolve(out, 'cached-recovery.json'), JSON.stringify(results, null, 2));
    await writeFile(resolve(out, 'cmap-inventory.json'), JSON.stringify(inventory, null, 2));
    await writeFile(resolve(out, 'REPRODUCE.txt'), 'SHIORI_AUDIT_CACHED=1 bun test src/pdf/export/contentText/auditCachedSamples.test.ts\n');
    // The original GSA streams explicitly put the selected headings in Tr 2.
    // The baseline's eight accepts therefore cannot be restored under the
    // required addressed-stroke refusal. Japanese/zh-ojs targets also use Tr 2.
    for (const row of results) expect({ key: row.key, outcome: row.after }).toMatchObject({ key: row.key, outcome: {
      mode: 'overlay', reason: row.key.startsWith('zh-hans-') ? 'style-change' : 'graphics-effect-unsupported',
    } });
  } finally { native.close(); }
}, 120000);
