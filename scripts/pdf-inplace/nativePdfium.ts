// Native read-only PDFium ABI from vendor/pdfium/linux-x64/include/.
import { dlopen, ptr, type Pointer } from 'bun:ffi';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { OracleGlyph } from './oracleGlyphs';
import type { GlyphEvidence, NativePath, NotdefProbe } from './glyphEvidence';
import { notdefProbePdf } from './notdefProbe';

type NativeHandle = Pointer | bigint;

export function openPdfium(library: string) {
  const { symbols: f } = dlopen(library, {
    FPDF_InitLibrary: { args: [], returns: 'void' },
    FPDF_DestroyLibrary: { args: [], returns: 'void' },
    FPDF_LoadMemDocument64: { args: ['ptr', 'u64', 'ptr'], returns: 'ptr' },
    FPDF_CloseDocument: { args: ['ptr'], returns: 'void' },
    FPDF_GetPageCount: { args: ['ptr'], returns: 'i32' },
    FPDF_LoadPage: { args: ['ptr', 'i32'], returns: 'ptr' },
    FPDF_ClosePage: { args: ['ptr'], returns: 'void' },
    FPDFText_LoadPage: { args: ['ptr'], returns: 'ptr' },
    FPDFText_ClosePage: { args: ['ptr'], returns: 'void' },
    FPDFText_CountChars: { args: ['ptr'], returns: 'i32' },
    FPDFText_GetUnicode: { args: ['ptr', 'i32'], returns: 'u32' },
    FPDFText_IsGenerated: { args: ['ptr', 'i32'], returns: 'i32' },
    FPDFText_GetCharOrigin: { args: ['ptr', 'i32', 'ptr', 'ptr'], returns: 'i32' },
    FPDFText_GetCharBox: { args: ['ptr', 'i32', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'i32' },
    FPDFText_GetTextObject: { args: ['ptr', 'i32'], returns: 'ptr' },
    FPDFTextObj_GetFont: { args: ['ptr'], returns: 'ptr' },
    FPDFFont_GetFontData: { args: ['ptr', 'ptr', 'u64', 'ptr'], returns: 'i32' },
    FPDFFont_GetIsEmbedded: { args: ['ptr'], returns: 'i32' },
    FPDFFont_GetGlyphPath: { args: ['ptr', 'u32', 'f32'], returns: 'ptr' },
    FPDFGlyphPath_CountGlyphSegments: { args: ['ptr'], returns: 'i32' },
    FPDFGlyphPath_GetGlyphPathSegment: { args: ['ptr', 'i32'], returns: 'ptr' },
    FPDFPathSegment_GetPoint: { args: ['ptr', 'ptr', 'ptr'], returns: 'i32' },
    FPDFPathSegment_GetType: { args: ['ptr'], returns: 'i32' },
    FPDFPathSegment_GetClose: { args: ['ptr'], returns: 'i32' },
    FPDFBitmap_CreateEx: { args: ['i32', 'i32', 'i32', 'ptr', 'i32'], returns: 'ptr' },
    FPDFBitmap_FillRect: { args: ['ptr', 'i32', 'i32', 'i32', 'i32', 'u32'], returns: 'i32' },
    FPDF_RenderPageBitmap: { args: ['ptr', 'ptr', 'i32', 'i32', 'i32', 'i32', 'i32', 'i32'], returns: 'void' },
    FPDFBitmap_Destroy: { args: ['ptr'], returns: 'void' },
    FPDF_GetPageWidthF: { args: ['ptr'], returns: 'f32' },
    FPDF_GetPageHeightF: { args: ['ptr'], returns: 'f32' },
  });
  f.FPDF_InitLibrary();
  function withPage<T>(path: string | Uint8Array, index: number, visit: (page: NativeHandle, pages: number) => T): T {
    const data = typeof path === 'string' ? readFileSync(path) : path;
    const doc = f.FPDF_LoadMemDocument64(ptr(data), data.length, null);
    assert(doc, `PDFium open failed: ${path}`);
    try {
      const page = f.FPDF_LoadPage(doc, index);
      assert(page, `PDFium load page failed: ${path}/${index}`);
      try { return visit(page, f.FPDF_GetPageCount(doc)); }
      finally { f.FPDF_ClosePage(page); }
    } finally { f.FPDF_CloseDocument(doc); assert(data.length > 0); }
  }
  function textAt(path: string, index = 0) {
    return withPage(path, index, (page, pages) => {
      const text = f.FPDFText_LoadPage(page); assert(text);
      try {
        return { pages, text: Array.from({ length: f.FPDFText_CountChars(text) }, (_, i) => String.fromCodePoint(f.FPDFText_GetUnicode(text, i))).join('') };
      } finally { f.FPDFText_ClosePage(text); }
    });
  }
  function fontHash(font: NativeHandle) {
    const size = new BigUint64Array(1);
    assert(f.FPDFFont_GetFontData(font, null, 0, ptr(size)));
    const buffer = Buffer.alloc(Number(size[0]));
    assert(f.FPDFFont_GetFontData(font, ptr(buffer), buffer.length, ptr(size)));
    return createHash('sha256').update(buffer).digest('hex');
  }
  function glyphPath(font: NativeHandle, unicode: number): NativePath | null {
    // Pinned PDFium chromium/7881 fpdf_edittext.cpp maps this Unicode through
    // CharCodeFromUnicode. This argument is neither a PDF code nor a GID.
    const path = f.FPDFFont_GetGlyphPath(font, unicode, 1000);
    if (!path) return null;
    const count = f.FPDFGlyphPath_CountGlyphSegments(path); assert(count >= 0);
    return Array.from({ length: count }, (_, i) => {
      const segment = f.FPDFGlyphPath_GetGlyphPathSegment(path, i); assert(segment);
      const x = new Float32Array(1), y = new Float32Array(1);
      assert(f.FPDFPathSegment_GetPoint(segment, ptr(x), ptr(y)));
      assert(Number.isFinite(x[0]) && Number.isFinite(y[0]));
      const type = f.FPDFPathSegment_GetType(segment); assert([0, 1, 2].includes(type));
      return { type, point: [x[0]!, y[0]!], closed: f.FPDFPathSegment_GetClose(segment) === 1 };
    });
  }
  async function measure(path: string, specs: readonly OracleGlyph[], fontHashes: Record<string, string>) {
    const objects = [...new Set(specs.map(g => g.fontObject))];
    const probeBytes = await notdefProbePdf(readFileSync(path), objects);
    writeFileSync(path.replace(/\.pdf$/, '.notdef-probe.pdf'), probeBytes);
    const probes = new Map<string, NotdefProbe[]>();
    for (const [pageIndex, object] of objects.entries()) withPage(probeBytes, pageIndex, page => {
      const text = f.FPDFText_LoadPage(page); assert(text);
      try {
        const obj = f.FPDFText_GetTextObject(text, 0); assert(obj);
        const font = f.FPDFTextObj_GetFont(obj); assert(font);
        assert.equal(fontHash(font), fontHashes[object], `native .notdef probe program mismatch: ${object}`);
        probes.set(object, [0xfffe, 0xffff].map(scalar => ({ scalar, path: glyphPath(font, scalar) })));
      } finally { f.FPDFText_ClosePage(text); }
    });
    return withPage(path, 0, page => {
      const text = f.FPDFText_LoadPage(page); assert(text);
      try {
        const glyphs: (OracleGlyph & GlyphEvidence & { origin: number[]; charBox: number[]; nativeIndex: number; nativeGenerated: boolean })[] = [];
        const generated: { index: number; unicode: string; matchedSource: boolean }[] = [], allText: string[] = [];
        const fontIds = new Map<string, NativeHandle>(), reverseIds = new Map<NativeHandle, string>(), hashes = new Map<NativeHandle, string>();
        for (let i = 0; i < f.FPDFText_CountChars(text); i++) {
          const unicode = String.fromCodePoint(f.FPDFText_GetUnicode(text, i)); allText.push(unicode);
          const obj: NativeHandle | null = f.FPDFText_GetTextObject(text, i);
          const isGenerated = f.FPDFText_IsGenerated(text, i) === 1;
          const sourceMatch = !!obj && specs[glyphs.length]?.unicode === unicode;
          if (isGenerated) {
            assert('\r\n '.includes(unicode), `unexpected generated char ${JSON.stringify(unicode)}`);
            generated.push({ index: i, unicode, matchedSource: sourceMatch });
            if (!sourceMatch) continue;
          }
          const spec = specs[glyphs.length]; assert(spec, `extra native glyph ${unicode}: ${path}`);
          assert.equal(spec.unicode, unicode, `code/Unicode mismatch: ${path}/${i}`);
          assert(obj, `source glyph has no text object: ${i}`);
          const font: NativeHandle | null = f.FPDFTextObj_GetFont(obj); assert(font);
          assert.equal(f.FPDFFont_GetIsEmbedded(font), 1, 'fixture must use embedded fonts');
          const identity = spec.fontObject;
          if (!fontIds.has(identity)) fontIds.set(identity, font);
          if (!reverseIds.has(font)) reverseIds.set(font, identity);
          assert.equal(fontIds.get(identity), font, 'source font object split');
          assert.equal(reverseIds.get(font), identity, 'distinct source fonts collapsed');
          if (!hashes.has(font)) hashes.set(font, fontHash(font));
          assert.equal(hashes.get(font), fontHashes[identity], `font program mismatch: ${identity}`);
          const x = new Float64Array(1), y = new Float64Array(1);
          assert(f.FPDFText_GetCharOrigin(text, i, ptr(x), ptr(y)));
          const l = new Float64Array(1), r = new Float64Array(1), b = new Float64Array(1), t = new Float64Array(1);
          assert(f.FPDFText_GetCharBox(text, i, ptr(l), ptr(r), ptr(b), ptr(t)));
          const nativePath = glyphPath(font, unicode.codePointAt(0)!);
          glyphs.push({ ...spec, origin: [x[0]!, y[0]!], charBox: [l[0]!, b[0]!, r[0]!, t[0]!],
            nativePath, notdefProbes: probes.get(identity), pathSegments: nativePath?.length ?? 0,
            nativeIndex: i, nativeGenerated: isGenerated });
        }
        assert.equal(glyphs.length, specs.length, `unaccounted source glyphs: ${path}`);
        const width = Math.round(f.FPDF_GetPageWidthF(page) * 2), height = Math.round(f.FPDF_GetPageHeightF(page) * 2);
        const pixels = Buffer.alloc(width * height * 4);
        const bitmap = f.FPDFBitmap_CreateEx(width, height, 4, ptr(pixels), width * 4); assert(bitmap);
        try {
          assert(f.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff));
          f.FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, 0);
        } finally { f.FPDFBitmap_Destroy(bitmap); }
        for (const glyph of glyphs) {
          if (!glyph.replacement || /^\s+$/u.test(glyph.unicode)) continue;
          const [l, b, r, t] = glyph.charBox as [number, number, number, number]; let ink = 0;
          for (let y = Math.max(0, Math.floor(height - t * 2)); y < Math.min(height, Math.ceil(height - b * 2)); y++) {
            for (let x = Math.max(0, Math.floor(l * 2)); x < Math.min(width, Math.ceil(r * 2)); x++) {
              const p = (y * width + x) * 4;
              if (Math.min(pixels[p]!, pixels[p + 1]!, pixels[p + 2]!) < 250) ink++;
            }
          }
          glyph.inkPixels = ink;
        }
        const rgb = Buffer.alloc(width * height * 3);
        for (let i = 0, j = 0; i < pixels.length; i += 4, j += 3) {
          rgb[j] = pixels[i + 2]!; rgb[j + 1] = pixels[i + 1]!; rgb[j + 2] = pixels[i]!;
        }
        writeFileSync(path.replace(/\.pdf$/, '.ppm'), Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), rgb]));
        return { glyphs, generated, text: allText.join(''), width, height, pixels };
      } finally { f.FPDFText_ClosePage(text); }
    });
  }
  return { textAt, measure, close: () => f.FPDF_DestroyLibrary() };
}
