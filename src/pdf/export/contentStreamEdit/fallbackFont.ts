import {RunCompileError} from './runRefusal';
// pdf-lib/fontkit boundary: subsets are built and checked in a disposable
// document. Never allocate objects in the user's document before compilation.
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, PDFDict, PDFName, PDFArray, PDFRawStream, PDFNumber, decodePDFRawStream, type PDFRef } from 'pdf-lib';
import { sourceFingerprint } from './replaceRun';
import { loadBundledFallbackFont } from './fallbackAssets';
import { contentFontInfo } from './glyphWidths';
import { fontCoverageFromDict } from '../fontCoverage/pdfLibAdapter';
import type { ResolvedRunFont } from './replaceRun';

export type FallbackOptions = { loadFont?: (name: string) => Promise<Uint8Array> };
export function fallbackFontName(baseFont: string, flags: number, text: string): string {
  if (/[\u3040-\u30ff]/u.test(text)) return 'NotoSansJP-Regular.otf';
  if (/\p{Script=Han}/u.test(text)) return 'NotoSansSC-Regular.otf';
  const family = flags & 1 || /Courier|Mono|Consolas/i.test(baseFont) ? 'Mono'
    : flags & 2 || /Times|Serif|Georgia|Cambria/i.test(baseFont) ? 'Serif' : 'Sans';
  const bold = !!(flags & (1 << 18)) || /Bold|Black|Heavy/i.test(baseFont);
  const italic = !!(flags & 64) || /Italic|Oblique/i.test(baseFont);
  const style = bold ? (italic ? 'BoldItalic' : 'Bold') : italic ? 'Italic' : 'Regular';
  return `Liberation${family}-${style}.ttf`;
}
export async function prepareFallback(doc: PDFDocument, resourceName: string, name: string,
  clusters: readonly string[], options: FallbackOptions): Promise<{ ref: PDFRef; resolved: ResolvedRunFont }> {
  const data = await (options.loadFont ?? loadBundledFallbackFont)(name);
  const parsed = fontkit.create(data);
  const permissions = (parsed as unknown as { 'OS/2'?: { fsType: { noEmbedding: boolean; viewOnly: boolean; editable: boolean; noSubsetting: boolean; bitmapOnly: boolean } } })['OS/2']?.fsType;
  if (!permissions || permissions.noEmbedding || permissions.noSubsetting || permissions.bitmapOnly || (permissions.viewOnly && !permissions.editable)) {
    throw new RunCompileError('fallback font embedding permission refused (OS/2 fsType)','font-permission');
  }
  for (const cluster of clusters) {
    const layout = parsed.layout(cluster);
    // This stage has no shaping-position compiler. Reject glyph substitution,
    // combining offsets and GPOS instead of discarding fontkit's positions.
    if (layout.glyphs.length !== 1 || !layout.glyphs[0]!.id ||
      String.fromCodePoint(...layout.glyphs[0]!.codePoints) !== cluster ||
      layout.positions.some((p,i) => p.xOffset || p.yOffset || p.yAdvance || p.xAdvance !== layout.glyphs[i]!.advanceWidth)) {
      throw new RunCompileError(`unsupported fallback shaping or missing glyph: ${cluster}`,'font-coverage');
    }
    if (!/^\s$/u.test(cluster) && layout.glyphs[0]!.path.bbox.width === 0 && layout.glyphs[0]!.path.bbox.height === 0) throw new RunCompileError('fallback glyph has no outline','font-coverage');
  }
  doc.registerFontkit(fontkit);
  const embedded = await doc.embedFont(data, { subset: true, customName: sourceFingerprint(data).slice(0,6).replace(/[0-9a-f]/g,c => String.fromCharCode(65 + parseInt(c,16))) + '+ShioriFallback' });
  const byCode = new Map<number,string>(), byText = new Map<string,Uint8Array>();
  for (const cluster of clusters) {
    const encoded = embedded.encodeText(cluster).asBytes();
    if (encoded.length !== 2) throw new RunCompileError('unsupported fallback code boundary','font-coverage');
    const code = encoded[0]! * 256 + encoded[1]!;
    if (byCode.has(code) && byCode.get(code) !== cluster) throw new RunCompileError('ambiguous fallback Unicode mapping','font-coverage');
    byCode.set(code,cluster); byText.set(cluster,encoded);
  }
  await embedded.embed();
  const dict = doc.context.lookup(embedded.ref,PDFDict);
  const cid = dict.lookup(PDFName.of('DescendantFonts'),PDFArray).lookup(0,PDFDict);
  const subtype = cid.lookup(PDFName.of('Subtype'),PDFName).decodeText();
  const descriptor = cid.lookup(PDFName.of('FontDescriptor'),PDFDict);
  if (dict.lookup(PDFName.of('Subtype'),PDFName).decodeText() !== 'Type0' || dict.lookup(PDFName.of('Encoding'),PDFName).decodeText() !== 'Identity-H' ||
    !['CIDFontType2','CIDFontType0'].includes(subtype)) throw new RunCompileError('invalid fallback font dictionary','font-coverage');
  if (!(dict.lookup(PDFName.of('ToUnicode')) instanceof PDFRawStream)) throw new RunCompileError('missing fallback ToUnicode','font-coverage');
  const widths = cid.lookup(PDFName.of('W'),PDFArray);
  // PDFium reads CID widths as integers. Canonicalize the writer's fractional
  // em widths so native and Poppler advance by the exact same dictionary W.
  for (let i=0;i<widths.size();i++) {
    const row = widths.lookup(i);
    if (row instanceof PDFArray) for (let j=0;j<row.size();j++) {
      row.set(j,PDFNumber.of(Math.round(row.lookup(j,PDFNumber).asNumber())));
    }
  }
  if (!(descriptor.lookup(PDFName.of(subtype === 'CIDFontType2' ? 'FontFile2' : 'FontFile3')) instanceof PDFRawStream)) throw new RunCompileError('missing fallback program','font-coverage');
  if (subtype === 'CIDFontType2' && cid.lookup(PDFName.of('CIDToGIDMap'),PDFName).decodeText() !== 'Identity') throw new RunCompileError('invalid fallback CID mapping','font-coverage');
  if (subtype === 'CIDFontType0') {
    cid.delete(PDFName.of('CIDToGIDMap'));
    const program = descriptor.lookup(PDFName.of('FontFile3'));
    if (!(program instanceof PDFRawStream)) throw new RunCompileError('invalid fallback CFF program','font-coverage');
    const bytes = decodePDFRawStream(program).decode();
    if (bytes[0] !== 1 || bytes[2] !== 4) throw new RunCompileError('unsupported fallback CFF header','font-coverage');
    // fontkit writes its top-DICT length into header.offSize (e.g. 24).
    // Match the Name INDEX offset size rather than guessing a valid value.
    const nameIndexSize = bytes[bytes[2]! + 2];
    if (!nameIndexSize || nameIndexSize > 4) throw new RunCompileError('invalid fallback CFF Name INDEX','font-coverage');
    if (bytes[3] !== nameIndexSize) {
      const repaired = bytes.slice(); repaired[3] = nameIndexSize;
      descriptor.set(PDFName.of('FontFile3'),doc.context.register(doc.context.flateStream(repaired,{Subtype:'CIDFontType0C'})));
    }
  }
  const info = contentFontInfo(dict);
  if (!info.ok) throw new RunCompileError(info.reason,'font-coverage');
  const coverage = fontCoverageFromDict(dict);
  for (const [cluster,bytes] of byText) {
    const verified = coverage.canEncode(cluster, { preferredCodes: [bytes] });
    if (!verified.ok || verified.bytes.length !== 2 || verified.bytes.some((b,i) => b !== bytes[i])) throw new RunCompileError(`fallback subset verification failed: ${cluster}: ${!verified.ok ? verified.reason : 'code mismatch'}`,'font-coverage');
  }
  return { ref: embedded.ref, resolved: { ...info, resourceName, objectId:embedded.ref.toString(), unicodeByCode:byCode,
    canEncode: coverage.canEncode } };
}
