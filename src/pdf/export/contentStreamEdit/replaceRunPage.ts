// Thin pdf-lib boundary. Decode inherited page content/resources, compile
// completely, then install a NEW stream on this page only. Never mutate fonts
// or shared content objects; refusal does not allocate any indirect objects.
import { decodePDFRawStream, PDFArray, PDFDict, PDFName, PDFRawStream, PDFRef, type PDFPage } from 'pdf-lib';
import type {RunEnvironment} from './textSafety';
import { coalesceContentStreams } from './tokenizer';
import { contentFontInfo } from './glyphWidths';
import { fontCoverageFromDict } from '../fontCoverage/pdfLibAdapter';
import type { FontCoverage } from '../fontCoverage/types';
import { pageRunPlan, type PageRunPlan } from './pageRunPlan';
import { runToUnicode } from './runToUnicode';
import { replaceRuns, sourceFingerprint, type Refusal, type ResolvedRunFont, type Overflow } from './replaceRun';

export type PageRunResult = ({ ok: true; bytes: Uint8Array } | (Refusal & { bytes?: Uint8Array })) & { overflow?: Overflow };

function decoded(raw: unknown): Uint8Array {
  if (!(raw instanceof PDFRawStream)) throw Error('unsupported content stream');
  return raw.dict.has(PDFName.of('Filter')) ? decodePDFRawStream(raw).decode() : raw.getContents();
}
export function inspectRunPage(page: PDFPage):
  | { ok: true; bytes: Uint8Array; sourceHash: string }
  | { ok: false; code:'unsupported-state'; reason: string } {
  try {
    const raw = page.node.Contents();
    const parts = raw instanceof PDFArray
      ? Array.from({ length: raw.size() }, (_, i) => decoded(raw.lookup(i))) : raw ? [decoded(raw)] : [];
    const bytes = parts.length ? coalesceContentStreams(parts) : new Uint8Array();
    return { ok: true, bytes, sourceHash: sourceFingerprint(bytes) };
  } catch(e){if(e instanceof TypeError || e instanceof ReferenceError)throw e;return{ok:false,code:'unsupported-state',reason:String(e)};}
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
    // Untargeted fonts still supply dictionary widths to the placement walk.
    // An empty map cannot authorize an edit in this font: the planner and
    // compiler both require every addressed code's Unicode provenance.
    const mapping = raw instanceof PDFRawStream
      ? runToUnicode(new TextDecoder('latin1').decode(decoded(raw)), info.bytesPerCode)
      : new Map<number, string>();

    let coverage = coverageByObject.get(font);
    if (!coverage) {
      coverage = fontCoverageFromDict(font);
      if (coverage.verification === 'unverified') {
        const reason = coverage.missing.find(m => !m.code)?.reason ?? 'source font coverage unverified';
        coverage.canEncode = text => ({ ok: false, reason, firstMissing: new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)[Symbol.iterator]().next().value?.segment ?? '', offset: 0 });
      }
      coverageByObject.set(font, coverage);
    }
    return [{ ...info, resourceName: name.decodeText(), objectId: ref.toString(), unicodeByCode: mapping??new Map<number,string>(), canEncode: coverage.canEncode }];
  });
}
export function markedContentProperties(page: PDFPage): Map<string, readonly string[] | null> {
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
export function runPageEnvironment(page:PDFPage):RunEnvironment {
  const extGStates=new Map<string,{setsFont:boolean;safe:boolean}>();
  const allowed=new Set(['Type','Font','LW','LC','LJ','ML','D','RI','OP','op','OPM','CA','ca','AIS','TK','BM','SA','SM','TR','TR2','BG','BG2','UCR','UCR2','HT','FL','SMask']);
  const states=page.node.Resources()?.lookupMaybe(PDFName.of('ExtGState'),PDFDict);
  for(const[name,raw]of states?.entries()??[]){const dict=states!.context.lookup(raw);if(dict instanceof PDFDict)extGStates.set(name.decodeText(),{setsFont:dict.has(PDFName.of('Font')),safe:dict.keys().every(k=>allowed.has(k.decodeText()))});}
  return {markedContentProperties:markedContentProperties(page),extGStates};
}
export function replaceRunPage(page: PDFPage, plan: PageRunPlan): PageRunResult {
  const source = inspectRunPage(page);
  if (!source.ok) return source;
  try {
    const result = replaceRuns(source.bytes, resolveRunFonts(page), { ...pageRunPlan(plan), ...runPageEnvironment(page) });
    if (result.ok && result.bytes !== source.bytes) {
      const stream = page.doc.context.flateStream(result.bytes);
      page.node.set(PDFName.of('Contents'), page.doc.context.register(stream));
    }
    return result;
  } catch (e) { if(e instanceof TypeError || e instanceof ReferenceError)throw e;return {ok:false,code:"unsupported-state",bytes:source.bytes,reason:String(e)}; }
}
