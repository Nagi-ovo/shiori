import { PDFArray, PDFDict, PDFRef, PDFStream } from 'pdf-lib';
import { isStrippedPropertyClone } from '../contentText/retypesetMarkedShows';
import { asDict, asName, value } from './pdfValues';
import { replacementKeys } from './markedContent';
import type { SemanticBinding, SemanticSpan } from './types';
import type { InstalledIntent, ObjectMap } from './verifyEdit';

const names = new Set<string>(replacementKeys.map(([key]) => key));

export function sameProperties(before: SemanticSpan, after: SemanticSpan, copy: ObjectMap) {
  if (before.source !== after.source) return false;
  if (before.source === 'inline') {
    const entries = (span: SemanticSpan) => {
      const props = span.occurrence.ops[span.beginOp]?.operands[1];
      return props?.kind === 'dict' && props.entries.filter(entry => !names.has(entry.key)).map(entry =>
        Array.from(span.occurrence.bytes!.subarray(entry.start, entry.end)));
    };
    return JSON.stringify(entries(before)) === JSON.stringify(entries(after));
  }
  if (!before.properties || !after.properties) return false;
  const entries = (dict: PDFDict) => dict.entries().filter(([key]) => !names.has(key.decodeText()));
  const old = entries(before.properties), next = new Map(entries(after.properties));
  return old.length === next.size && old.every(([key, raw]) => {
    const mapped = copy(before.properties!.context.lookup(raw)!);
    const candidate = next.get(key);
    const resolved = after.properties!.context.lookup(candidate);
    return mapped ? mapped === resolved : candidate === raw ||
      (!(raw instanceof PDFRef || raw instanceof PDFDict || raw instanceof PDFArray || raw instanceof PDFStream) &&
        candidate?.constructor === raw.constructor && candidate.toString() === raw.toString());
  });
}


// A writer flag alone cannot prove that this particular binding was stripped.
export function wasLegacyStrip(
  tagged: boolean, binding: SemanticBinding, edit: InstalledIntent, spans: ReadonlyMap<SemanticSpan, SemanticSpan>,
): boolean {
  return !tagged && binding.replacementKey !== undefined && binding.dependency.source !== 'struct-elem' &&
    !!edit.outcome.strippedEquivalent && binding.spans.length > 0 && binding.spans.every(span => {
      const next = spans.get(span);
      return next && span.glyphs.length > 0 && !span.paints.length && span.glyphs.every(glyph => edit.intent.glyphs.has(glyph)) &&
        !next.replacement.some(r => r.key === binding.replacementKey);
    });
}

// Reuse a writer-owned clone only if no sibling operator or nested paint
// can look it up. The source dictionary and its original name stay intact.
export function canReuseStrippedProperty(span: SemanticSpan): boolean {
  return !!span.properties && isStrippedPropertyClone(span.properties) && hasExclusivePropertyUse(span);
}

// The combined page operators include all /Contents parts and DP points.
// Restrict the proof to resource scopes without nested content consumers.
export function hasExclusivePropertyUse(span: SemanticSpan, propertyName = span.propertyName): boolean {
  const { occurrence } = span, resources = occurrence.resources;
  const annots = value(occurrence.owner, 'Annots');
  if (!propertyName || !resources ||
      resources.keys().some(key => !['Font', 'Properties', 'ProcSet'].includes(key.decodeText())) ||
      (annots && (!(annots instanceof PDFArray) || annots.size() > 0))) return false;
  const fonts = asDict(value(resources, 'Font'));
  return !!fonts && fonts.entries().every(([, raw]) => {
    const font = asDict(fonts.context.lookup(raw));
    return font && ['Type1', 'MMType1', 'TrueType', 'Type0'].includes(asName(value(font, 'Subtype')) ?? '');
  }) && occurrence.ops.every((op, i) => {
    if (i === span.beginOp || (op.operator !== 'BDC' && op.operator !== 'DP')) return true;
    const operand = op.operands[1];
    return operand?.kind !== 'name' || operand.value !== propertyName;
  });
}
