import { PDFDict, PDFName, PDFRef } from 'pdf-lib';
import { streamBytes, fontInputFromDict } from '../fontCoverage/pdfLibAdapter';
import { glyphUnicode, standardFont } from '../fontCoverage/encodings';
import { resolveStandardMetrics } from '../fontCoverage/standardMetrics';
import { contentFontInfo } from '../contentStreamEdit/glyphWidths';
import { runToUnicode } from '../contentStreamEdit/runToUnicode';
import type { ResolvedRunFont } from '../contentStreamEdit/replaceRun';

export type LocalStandard = { font?: ResolvedRunFont; afm?: ReturnType<typeof resolveStandardMetrics>; reason?: string };

export function localStandardFonts(dictionary: PDFDict | undefined): Map<string, LocalStandard> {
  const result = new Map<string, LocalStandard>();
  for (const [key, ref] of dictionary?.entries() ?? []) {
    const raw = dictionary!.context.lookup(ref);
    if (!(raw instanceof PDFDict) || !(ref instanceof PDFRef)) continue;
    if (raw.lookup(PDFName.of('Subtype')) !== PDFName.of('Type1')) continue;
    const base = raw.lookup(PDFName.of('BaseFont'));
    if (!(base instanceof PDFName) || !standardFont(base.decodeText())) continue;
    const descriptor = raw.lookup(PDFName.of('FontDescriptor'));
    if (descriptor instanceof PDFDict && ['FontFile', 'FontFile2', 'FontFile3'].some(k => descriptor.has(PDFName.of(k)))) continue;

    const name = key.decodeText();
    const input = fontInputFromDict(raw);
    const encoding = input.encoding;
    if (input.error || input.fontMatrix || encoding && (
      typeof encoding !== 'string' || !['WinAnsiEncoding', 'MacRomanEncoding', 'StandardEncoding'].includes(encoding)
    )) {
      result.set(name, { reason: 'standard font has a custom encoding or invalid font dictionary' });
      continue;
    }
    const afm = resolveStandardMetrics(input)!;
    const info = contentFontInfo(raw, { standard14Afm: true });
    const labels = new Map<number, string>();
    for (const [code, glyph] of afm.names) {
      const label = glyphUnicode(glyph);
      if (label && afm.widthOf(code) !== undefined) labels.set(code, label);
    }
    const cmap = raw.lookup(PDFName.of('ToUnicode'));
    if (cmap !== undefined) {
      const explicit = runToUnicode(new TextDecoder('latin1').decode(streamBytes(cmap)), 1);
      if (!explicit || [...explicit].some(([code, label]) => labels.get(code) !== label)) {
        result.set(name, { reason: 'standard font encoding conflicts with ToUnicode' });
        continue;
      }
    }
    const first = input.firstChar ?? -1;
    const last = input.lastChar ?? first + (input.widths?.length ?? 0) - 1;
    if (!info.ok || input.widths && (!Number.isInteger(first) || first < 0 || last > 255 ||
        last !== first + input.widths.length - 1 || input.widths.some((width, i) =>
          width !== (afm.widthOf(first + i) ?? 0)))) {
      result.set(name, { reason: 'explicit widths conflict with standard font metrics' });
      continue;
    }
    result.set(name, { afm, font: { ...info, unicodeByCode: labels, resourceName: name, objectId: ref.toString() } });
  }
  return result;
}
