import { PDFName } from 'pdf-lib';
import { asDict, asIndex, asText, decodeTextBytes, entry, value } from './pdfValues';
import type { SemanticIssue, SemanticIssueKind, SemanticOccurrence, SemanticPage, SemanticSpan } from './types';

export const replacementKeys = [
  ['ActualText', 'actual-text'], ['Alt', 'alt'], ['E', 'expansion'],
] as const;

export function reportIssue(
  page: SemanticPage, kind: SemanticIssueKind, at: Omit<SemanticIssue, 'kind'> = {},
  spans: readonly SemanticSpan[] = [],
): SemanticIssue {
  const issue = { kind, ...at };
  page.issues.push(issue);
  at.occurrence?.issues.push(issue);
  for (const span of spans) span.issues.push(issue);
  return issue;
}

export function readMarkedContent(page: SemanticPage, occurrence: SemanticOccurrence): void {
  let scopes = occurrence.inheritedSpans;
  const floor = scopes.length;
  const properties = occurrence.resources && asDict(value(occurrence.resources, 'Properties'));
  const byName = new Map(properties?.entries().map(([key, raw]) => [key.decodeText(), asDict(properties.context.lookup(raw))]));
  const localIds = new Map<number, SemanticSpan[]>();
  let partIndex = 0;

  for (const [opIndex, op] of occurrence.ops.entries()) {
    occurrence.scopesByOp.push(scopes);
    if (op.operator === 'EMC') {
      if (scopes.length === floor) reportIssue(page, 'marked-content', { occurrence, opIndex }, scopes);
      else {
        scopes.at(-1)!.endOp = opIndex;
        scopes = scopes.slice(0, -1);
      }
      continue;
    }
    if (op.operator !== 'BMC' && op.operator !== 'BDC') continue;
    const [tag, prop] = op.operands;
    while (op.start >= (occurrence.partStarts[partIndex + 1] ?? Infinity)) partIndex += 1;
    const span: SemanticSpan = {
      occurrence, beginOp: opIndex, part: occurrence.parts[partIndex], tag: tag?.kind === 'name' ? tag.value : undefined,
      source: prop?.kind === 'name' ? 'properties' : 'inline',
      ancestors: scopes, replacement: [], issues: [], glyphs: [], paints: [],
    };
    occurrence.spans.push(span);
    scopes = [...scopes, span];
    const markIssue = (kind: SemanticIssueKind) => reportIssue(page, kind, { occurrence, opIndex }, [span]);
    if (!span.tag || op.operands.length !== (op.operator === 'BMC' ? 1 : 2)) markIssue('marked-content');
    if (op.operator === 'BMC') continue;

    if (prop?.kind === 'dict') {
      const items = new Map(prop.entries.map(item => [item.key, item]));
      if (items.size !== prop.entries.length) markIssue('property-value');
      const id = items.get('MCID');
      if (id) {
        if (id.numberValue !== undefined && Number.isSafeInteger(id.numberValue) && id.numberValue >= 0) span.mcid = id.numberValue;
        else markIssue('property-value');
      }
      for (const [key, kind] of replacementKeys) {
        const item = items.get(key);
        if (!item) continue;
        if (item.stringBytes) span.replacement.push({ key, kind, text: decodeTextBytes(item.stringBytes) });
        else markIssue('property-value');
      }
    } else if (prop?.kind === 'name') {
      span.propertyName = prop.value;
      span.properties = byName.get(prop.value);
      const dict = span.properties;
      if (!dict) markIssue('property-name');
      else {
        span.mcid = asIndex(value(dict, 'MCID'));
        if (dict.has(PDFName.of('MCID')) && span.mcid === undefined) markIssue('property-value');
        for (const [key, kind] of replacementKeys) {
          if (entry(dict, key) === undefined) continue;
          const text = asText(value(dict, key));
          if (text === undefined) markIssue('property-value');
          else span.replacement.push({ key, kind, text });
        }
      }
    } else markIssue('property-value');

    if (span.mcid !== undefined) {
      const earlier = localIds.get(span.mcid);
      if (earlier) earlier.push(span);
      else localIds.set(span.mcid, [span]);
    }
  }
  for (const span of scopes.slice(floor)) {
    reportIssue(page, 'marked-content', { occurrence, opIndex: span.beginOp }, [span]);
  }
  for (const [mcid, spans] of localIds) {
    if (spans.length > 1) reportIssue(page, 'duplicate-mcid', { occurrence, mcid }, spans);
  }
}
