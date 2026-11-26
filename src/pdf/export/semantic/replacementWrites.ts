import { PDFArray, PDFHexString, PDFName } from 'pdf-lib';
import type { PDFDict, PDFPage, PDFStream } from 'pdf-lib';
import { pdfName } from '../contentStreamEdit/runEncoding';
import { decodedContent } from './content';
import { compactText, glyphText, inReadingOrder } from './editIntent';
import { canReuseStrippedProperty, hasExclusivePropertyUse, sameProperties, wasLegacyStrip } from './replacementProperties';
import { asDict, asIndex, asName, value } from './pdfValues';
import type { ReplacementText, SemanticBinding, SemanticPage, SemanticSpan } from './types';
import { mapsBinding, matchAddresses, type InstalledIntent, type ObjectMap } from './verifyEdit';

type Patch = { start: number; end: number; bytes: Uint8Array };

function installPatches(page: PDFPage, patches: Map<PDFStream, Patch[]>, parts: PDFStream[]) {
  if (!patches.size) return;
  const contents = PDFName.of('Contents');
  const original = page.node.Contents();
  const list = original instanceof PDFArray ? original.clone() : undefined;
  for (const [part, edits] of patches) {
    const source = decodedContent(part);
    const length = source.length + edits.reduce((sum, p) => sum + p.bytes.length + p.start - p.end, 0);
    const bytes = new Uint8Array(length);
    let from = 0, offset = 0;
    for (const patch of edits.sort((a, b) => a.start - b.start)) {
      bytes.set(source.subarray(from, patch.start), offset);
      offset += patch.start - from;
      bytes.set(patch.bytes, offset);
      offset += patch.bytes.length;
      from = patch.end;
    }
    bytes.set(source.subarray(from), offset);
    const stream = page.doc.context.flateStream(bytes);
    for (const [key, entry] of part.dict.entries()) {
      if (!['Filter', 'DecodeParms', 'Length'].includes(key.decodeText())) stream.dict.set(key, entry);
    }
    const ref = page.doc.context.register(stream);
    if (list) list.set(parts.indexOf(part), ref);
    else page.node.set(contents, ref);
  }
  if (list) page.node.set(contents, list);
}

function singleStructureItem(owner: PDFDict, span: SemanticSpan): boolean {
  let kid = value(owner, 'K');
  if (kid instanceof PDFArray && kid.size() === 1) kid = kid.lookup(0);
  if (asIndex(kid) === span.mcid) return span.mcid !== undefined;
  const ref = asDict(kid);
  return !!ref && asName(value(ref, 'Type')) === 'MCR' && asIndex(value(ref, 'MCID')) === span.mcid;
}

/** Apply replacement values to the already compiled candidate. A page BDC
 * can get its own property list. A structure element is mutable only when
 * its single child is exactly the verified span. Verification still checks
 * the candidate glyphs, stream ownership and all other dependencies. */
export function writeReplacementValues(
  page: PDFPage, before: SemanticPage, after: SemanticPage, installed: InstalledIntent[], copy: ObjectMap,
): Map<SemanticBinding, string> {
  const updates = new Map<SemanticBinding, string>();
  if (!installed.some(({ intent }) => intent.replacements.length)) return updates;
  const map = matchAddresses(before, after);
  const root = after.occurrences[0]!;
  const patches = new Map<PDFStream, Patch[]>();
  const bySpan = new Map<SemanticSpan, Map<ReplacementText['key'], PDFHexString>>();
  const originalNames = new Map<SemanticSpan, string>();
  const obsoleteNames = new Set<PDFName>();
  for (const binding of before.dependencies) {
    const key = binding.replacementKey;
    if (!key || binding.objects.length || binding.spans.length !== 1) continue;
    const claims = installed.filter(({ intent }) => intent.replacements.includes(binding));
    if (claims.length !== 1) continue;
    const { intent, outcome } = claims[0]!;
    if (outcome.flow || intent.refusal) continue;
    const span = binding.spans[0]!, next = map.spans.get(span);
    if (!next || next.occurrence !== root || span.occurrence !== before.occurrences[0] ||
        !span.glyphs.length || span.paints.length || span.issues.length ||
        !span.glyphs.every(g => intent.glyphs.has(g)) ||
        [...intent.glyphs].some(g => !g.spans.includes(span))) continue;
    const read = glyphText(inReadingOrder(next.glyphs));
    const text = intent.overlay.text;
    if (read === undefined || compactText(read) !== compactText(text)) continue;
    const encoded = PDFHexString.fromText(text);
    if (binding.dependency.source === 'struct-elem') {
      if (!binding.owner || !singleStructureItem(binding.owner, span)) continue;
      const copied = after.dependencies.find(candidate => mapsBinding(binding, candidate, map, copy));
      if (!copied?.owner) continue;
      copied.owner.set(PDFName.of(key), encoded);
    } else {
      if (wasLegacyStrip(before.tagged, binding, claims[0]!, map.spans)) continue;
      if (!next.part || root.parts.indexOf(next.part) !== root.parts.lastIndexOf(next.part) ||
          !sameProperties(span, next, copy)) continue;
      const start = root.partStarts[root.parts.indexOf(next.part)]!;
      if (root.ops[next.beginOp]!.end > start + decodedContent(next.part).length) continue;
      const keys = bySpan.get(next) ?? new Map();
      keys.set(key, encoded);
      bySpan.set(next, keys);
      if (span.propertyName) originalNames.set(next, span.propertyName);
    }
    updates.set(binding, text);
  }

  const resources = root.resources?.clone();
  const propertyList = resources && asDict(value(resources, 'Properties'));
  const properties = propertyList?.clone();
  let propertyIndex = 1, copiedProperties = false;
  const encoder = new TextEncoder();
  for (const [span, keys] of bySpan) {
    const part = span.part!;
    const shift = root.partStarts[root.parts.indexOf(part)]!;
    const add = (start: number, end: number, text: string) => {
      const list = patches.get(part) ?? [];
      list.push({ start: start - shift, end: end - shift, bytes: encoder.encode(text) });
      patches.set(part, list);
    };
    const op = root.ops[span.beginOp]!, operand = op.operands[1]!;
    if (operand.kind === 'dict') {
      let extra = '';
      for (const [key, encoded] of keys) {
        const current = operand.entries.find(entry => entry.key === key);
        if (current) add(current.valueStart, current.end, encoded.toString());
        else extra += ` /${key} ${encoded}`;
      }
      // The only bytes after the dictionary delimiter are whitespace,
      // comments and BDC. Insert immediately before the delimiter.
      if (extra) {
        const end = operand.entries.at(-1)?.end;
        if (end === undefined) add(op.start, op.end, `${pdfName(span.tag!)} <<${extra} >> BDC`);
        else add(end, end, extra);
      }
    } else if (operand.kind === 'name' && properties && span.properties) {
      const dict = span.properties.clone();
      for (const [key, encoded] of keys) dict.set(PDFName.of(key), encoded);
      if (canReuseStrippedProperty(span)) {
        properties.set(PDFName.of(operand.value), dict);
      } else {
        while (properties.has(PDFName.of(`ShioriSemantic${propertyIndex}`))) propertyIndex += 1;
        const property = PDFName.of(`ShioriSemantic${propertyIndex++}`);
        properties.set(property, dict);
        add(op.start, op.end, `${pdfName(span.tag!)} ${property} BDC`);
        if (before.tagged && hasExclusivePropertyUse(span)) obsoleteNames.add(PDFName.of(operand.value));
      }
      const originalName = originalNames.get(span);
      if (before.tagged && originalName && originalName !== operand.value && hasExclusivePropertyUse(span, originalName)) {
        obsoleteNames.add(PDFName.of(originalName));
      }
      copiedProperties = true;
    }
  }
  if (copiedProperties) {
    for (const key of obsoleteNames) {
      if (propertyList!.has(key)) properties!.delete(key);
    }
    resources!.set(PDFName.of('Properties'), properties!);
    page.node.set(PDFName.of('Resources'), resources!);
  }
  installPatches(page, patches, root.parts);
  return updates;
}
