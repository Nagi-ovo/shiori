// Thin pdf-lib boundary. Decode inherited page content/resources, compile
// completely, then install a NEW stream on this page only. Never mutate fonts
// or shared content objects; refusal does not allocate any indirect objects.
import { decodePDFRawStream, PDFArray, PDFDict, PDFName, PDFRawStream, PDFRef, type PDFPage } from 'pdf-lib';
import { coalesceContentStreams } from './tokenizer';
import { contentFontInfo } from './glyphWidths';
import { fontCoverageFromDict } from '../fontCoverage/pdfLibAdapter';
import type { FontCoverage } from '../fontCoverage/types';
import { runToUnicode } from './runToUnicode';
import { replaceRuns, sourceFingerprint, type Refusal, type ResolvedRunFont, type RunPlan } from './replaceRun';

export type PageRunResult = { ok: true; bytes: Uint8Array } | (Refusal & { bytes?: Uint8Array });

function decoded(raw: unknown): Uint8Array {
  if (!(raw instanceof PDFRawStream)) throw Error('unsupported content stream');
  return raw.dict.has(PDFName.of('Filter')) ? decodePDFRawStream(raw).decode() : raw.getContents();
}
export function inspectRunPage(page: PDFPage):
  | { ok: true; bytes: Uint8Array; sourceHash: string }
  | { ok: false; reason: string } {
  try {
    const raw = page.node.Contents();
    const parts = raw instanceof PDFArray
      ? Array.from({ length: raw.size() }, (_, i) => decoded(raw.lookup(i))) : raw ? [decoded(raw)] : [];
    const bytes = parts.length ? coalesceContentStreams(parts) : new Uint8Array();
    return { ok: true, bytes, sourceHash: sourceFingerprint(bytes) };
  } catch (e) { return { ok: false, reason: String(e) }; }
}
export function resolveRunFonts(page: PDFPage): ResolvedRunFont[] {
  const dict = page.node.Resources()?.lookupMaybe(PDFName.of('Font'), PDFDict);
  if (!dict) return [];
  const coverageByObject = new Map<PDFDict, FontCoverage>();
  return dict.entries().flatMap(([name, ref]) => {
    if (!(ref instanceof PDFRef)) return [];
    const font = dict.context.lookup(ref);
    if (!(font instanceof PDFDict)) return [];
    const info = contentFontInfo(font);
    if (!info.ok) return [];
    const raw = font.lookup(PDFName.of('ToUnicode'));
    if (!(raw instanceof PDFRawStream)) return [];
    const mapping = runToUnicode(new TextDecoder('latin1').decode(decoded(raw)), info.bytesPerCode);
    if (!mapping) return [];
    let coverage = coverageByObject.get(font);
    if (!coverage) {
      coverage = fontCoverageFromDict(font);
      if (coverage.verification === 'unverified') {
        const reason = coverage.missing.find(m => !m.code)?.reason ?? 'source font coverage unverified';
        coverage.canEncode = text => ({ ok: false, reason, firstMissing: new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)[Symbol.iterator]().next().value?.segment ?? '', offset: 0 });
      }
      coverageByObject.set(font, coverage);
    }
    return [{ ...info, resourceName: name.decodeText(), objectId: ref.toString(), unicodeByCode: mapping, canEncode: coverage.canEncode }];
  });
}
function markedContentProperties(page: PDFPage): Map<string, readonly string[] | null> {
  const resolved = new Map<string, readonly string[] | null>();
  try {
    const properties = page.node.Resources()?.lookupMaybe(PDFName.of('Properties'), PDFDict);
    for (const [name, raw] of properties?.entries() ?? []) {
      try {
        const dict = properties!.context.lookup(raw);
        resolved.set(name.decodeText(), dict instanceof PDFDict ? dict.keys().map(k => k.decodeText()) : null);
      } catch { resolved.set(name.decodeText(), null); }
    }
  } catch { /* An unresolvable /Properties dictionary leaves named spans unsafe. */ }
  return resolved;
}
export function replaceRunPage(page: PDFPage, plan: RunPlan): PageRunResult {
  const source = inspectRunPage(page);
  if (!source.ok) return source;
  try {
    const result = replaceRuns(source.bytes, resolveRunFonts(page), { ...plan, markedContentProperties: markedContentProperties(page) });
    if (result.ok && result.bytes !== source.bytes) {
      const stream = page.doc.context.flateStream(result.bytes);
      page.node.set(PDFName.of('Contents'), page.doc.context.register(stream));
    }
    return result;
  } catch (e) { return { ok: false as const, bytes: source.bytes, reason: String(e) }; }
}
