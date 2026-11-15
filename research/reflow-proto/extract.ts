// Read-only corpus adapter. Reuses the existing PDF dictionary/state parsers.
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFNumber } from 'pdf-lib';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { inspectRunPage, resolveRunFonts } from '../../src/pdf/export/contentStreamEdit/replaceRunPage';
import { tokenizeContentStream } from '../../src/pdf/export/contentStreamEdit/tokenizer';
import { walkTextPlacements, type ShowTextState } from '../../src/pdf/export/contentStreamEdit/textState';
import { lookup, streamBytes, fontCoverageFromDict } from '../../src/pdf/export/fontCoverage/pdfLibAdapter';
import { openPdfium } from '../../scripts/pdf-inplace/nativePdfium';

const base = resolve(import.meta.dir);
const corpus = process.env.CORPUS_CACHE ?? '/workspace/shiori-wt/pdf-inplace-ui/test-artifacts/pdf-corpus/cache';
const library = process.env.PDFIUM_LIBRARY ?? '/workspace/shiori-wt/pdf-inplace-ui/vendor/pdfium/linux-x64/lib/libpdfium.so';
const native = openPdfium(library);
const ids = ['zh-hans-law', 'zh-hans-education', 'zh-hans-ethics',
  'arxiv-2611.17030', 'arxiv-2611.17052', 'arxiv-2611.17053'];
const manifest = JSON.parse(readFileSync(resolve(base, '../../scripts/pdf-corpus/manifest.json'), 'utf8'));
mkdirSync(resolve(base, 'tmp/fonts'), { recursive: true });
const results = [];
try {
  for (const id of ids) {
    const path = resolve(corpus, `${id}.pdf`), bytes = readFileSync(path);
    const provenance = manifest.find((e: { id: string }) => e.id === id);
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== provenance.sha256) throw Error(`Corpus hash changed: ${id}`);
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const pageIndex = 1, page = doc.getPage(pageIndex), content = inspectRunPage(page);
    if (!content.ok) throw Error(`${id}: ${content.reason}`);
    const ops = tokenizeContentStream(content.bytes), fonts = resolveRunFonts(page);
    const fontDict = page.node.Resources()!.lookup(PDFName.of('Font'), PDFDict);
    const payloads: Record<string, unknown> = {};
    const codeMaps = new Map<string, Map<number, string>>();
    const glyphIds = new Map<string, Map<number, number>>();
    for (const font of fonts) {
      const dict = fontDict.lookup(PDFName.of(font.resourceName), PDFDict);
      const coverage = fontCoverageFromDict(dict);
      const decoded = new Map(font.unicodeByCode);
      for (const [hex, text] of coverage.codeToUnicode) {
        if (!decoded.has(parseInt(hex, 16))) decoded.set(parseInt(hex, 16), text);
      }
      codeMaps.set(font.resourceName, decoded);
      glyphIds.set(font.resourceName, new Map([...coverage.glyphIds].map(([hex, gid]) => [parseInt(hex, 16), gid])));
      const actual = lookup(dict, 'DescendantFonts') instanceof PDFArray
        ? (lookup(dict, 'DescendantFonts') as PDFArray).lookup(0, PDFDict) : dict;
      const desc = lookup(actual, 'FontDescriptor');
      let programPath: string | null = null, programKind = 'missing', byteCount = 0;
      if (desc instanceof PDFDict) {
        for (const key of ['FontFile2', 'FontFile3', 'FontFile']) {
          const raw = lookup(desc, key);
          if (raw === undefined) continue;
          const data = streamBytes(raw);
          programPath = `tmp/fonts/${id}-${font.resourceName}.bin`;
          programKind = key; byteCount = data.length;
          writeFileSync(resolve(base, programPath), data); break;
        }
      }
      // Includes all proven source-code candidates, not only this paragraph.
      const mapping: Record<string, unknown> = {};
      for (const [code, text] of decoded) {
        const hex = code.toString(16).padStart(font.bytesPerCode * 2, '0');
        mapping[text] = { code, gid: coverage.glyphIds.get(hex) ?? null, width1000: font.widthOf(code),
          eligible: (coverage.encodable.get(text) ?? []).some(bytes =>
            Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('') === hex) };
      }
      payloads[font.resourceName] = { name: coverage.baseFont, object: font.objectId,
        programPath, programKind, byteCount, verified: coverage.verification,
        mapping, ascent: font.ascentEm, descent: font.descentEm,
        fsType: desc instanceof PDFDict && lookup(desc, 'Flags') instanceof PDFNumber
          ? 'not checked: research only, no embedding' : 'unknown' };
    }
    const states = new Map<string, ShowTextState>();
    // Research geometry only: Tr 1/2 does not change advances. The shared
    // production walker now refuses strokes; neutralize these operators ONLY
    // for numeric extraction, record the loss of paint semantics explicitly,
    // and never call the result a RegionProof or safe editable paragraph.
    let strokeGeometryOnlyOps = 0;
    const geometryOps = ops.map(op => {
      if (op.operator !== 'Tr' || op.operands.length !== 1) return op;
      const mode = op.operands[0];
      if (mode?.kind !== 'number' || ![1, 2].includes(mode.value)) return op;
      strokeGeometryOnlyOps++;
      return { ...op, operands: [{ kind: 'number' as const, value: 0 }] };
    });
    const walk = walkTextPlacements(geometryOps, {
      resolveFont: name => fonts.find(f => f.resourceName === name) ?? null,
      onShow: s => states.set(`${s.opIndex}/${s.arrayItemIndex}`, s),
      extGStateSetsFont: () => false, // Research extraction only; no safety proof.
    });
    if (!walk.ok) throw Error(`${id}: ${walk.reason}`);
    const geometry = native.inspectPage(path, pageIndex);
    const maxOriginX = id === 'arxiv-2611.17030' ? 300 : id === 'arxiv-2611.17053' ? 310 : null;
    let columnClippedGlyphs = 0;
    const glyphs = walk.glyphs.flatMap((g, index) => {
      const font = fonts.find(f => f.resourceName === g.fontName)!;
      const state = states.get(`${g.opIndex}/${g.arrayItemIndex}`)!;
      const [origin, endpoint] = g.coreQuad;
      // Manual left-column crop by glyph origin; not a proven column boundary.
      if (maxOriginX !== null && origin.x > maxOriginX) { columnClippedGlyphs++; return []; }
      if (Math.abs(endpoint.y - origin.y) > 0.001) return [];
      const size = state.fontSizePt ?? state.fontSize;
      const decoded = codeMaps.get(g.fontName)!.get(g.code);
      const near = geometry.glyphs.filter(n => Math.abs(n.origin[0] - origin.x) < 1
        && Math.abs(n.origin[1] - origin.y) < 0.02).sort((a,b) =>
          Math.abs(a.origin[0]-origin.x) - Math.abs(b.origin[0]-origin.x))[0];
      const explicitEncoding = lookup(fontDict.lookup(PDFName.of(g.fontName), PDFDict), 'Encoding');
      const literalSpace = font.bytesPerCode === 1 && g.code === 32
        && explicitEncoding instanceof PDFName && ['WinAnsiEncoding', 'MacRomanEncoding', 'StandardEncoding'].includes(explicitEncoding.decodeText());
      const text = decoded ?? (literalSpace ? ' ' : near?.text) ?? '\uFFFD';
      const matches = geometry.glyphs.filter(n => n.text === text
        && Math.abs(n.origin[0] - origin.x) < 1 && Math.abs(n.origin[1] - origin.y) < 0.02)
        .sort((a,b) => Math.abs(a.origin[0]-origin.x) - Math.abs(b.origin[0]-origin.x));
      const n = matches[0];
      return [{ index, text, font: g.fontName, code: g.code,
        gid: glyphIds.get(g.fontName)?.get(g.code) ?? null,
        x: origin.x, y: origin.y, size,
        advance: g.tjCompensation / 1000 * state.fontSize * state.advanceVector.x,
        width1000: font.widthOf(g.code), tc: state.charSpacing, tw: state.wordSpacing,
        emX: state.fontSize * state.advanceVector.x, sizeText: state.fontSize,
        xScale: state.advanceVector.x, wordSpaced: font.appliesWordSpacing && g.code === 32,
        source: { streamHash: content.sourceHash, opIndex: g.opIndex, itemIndex: g.arrayItemIndex,
          byteStart: g.byteOffset, byteEnd: g.byteOffset + g.byteLength, fontObject: font.objectId },
        unicodeProven: !!decoded || literalSpace,
        nativeOrigin: n?.origin ?? null, ink: text.trim() ? n?.box ?? [origin.x, origin.y - size * 0.2, endpoint.x, origin.y + size * 0.8] : [origin.x, origin.y, origin.x, origin.y],
      }];
    });
    const lines: typeof glyphs[] = [];
    for (const g of glyphs) {
      const line = lines.find(l => Math.abs(l[0]!.y - g.y) < 0.01);
      if (line) line.push(g); else lines.push([g]);
    }
    lines.sort((a, b) => b[0]!.y - a[0]!.y);
    for (const l of lines) l.sort((a, b) => a.x - b.x);
    results.push({ id, page: pageIndex + 1, hash, url: provenance.url, licence: provenance.licence,
      strokeGeometryOnlyOps,
      columnClip: { maxOriginX, excludedGlyphs: columnClippedGlyphs },
      fonts: payloads, lines: lines.map((glyphs, index) => ({ index, text: glyphs.map(g => g.text).join(''),
        baseline: glyphs[0]!.y, left: glyphs[0]!.x, right: Math.max(...glyphs.map(g => g.x + g.advance)), glyphs })) });
  }
} finally { native.close(); }
writeFileSync(resolve(base, 'tmp/extracted.json'), JSON.stringify(results));
for (const r of results) console.log(r.id, r.lines.map(l => `${l.index}: ${l.text}`).join('\n'));
