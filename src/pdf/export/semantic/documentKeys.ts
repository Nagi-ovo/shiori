import { PDFStream } from 'pdf-lib';
import { reportIssue } from './markedContent';
import { asDict, asIndex, value } from './pdfValues';
import type { SemanticOccurrence, SemanticPage } from './types';

export function checkDocumentParentKeys(pages: readonly SemanticPage[]): void {
  const uses = new Map<number, { page: SemanticPage; occurrence: SemanticOccurrence }[]>();
  for (const page of pages.filter(page => page.tagged)) for (const occurrence of page.occurrences) {
    const key = asIndex(value(occurrence.owner, 'StructParents'));
    if (key === undefined) continue;
    const previous = uses.get(key) ?? [];
    previous.push({ page, occurrence });
    uses.set(key, previous);
  }
  const objectOwners = new Map<number, Set<object>>();
  for (const page of pages) for (const { object } of page.objects.values()) {
    const dict = object instanceof PDFStream ? object.dict : asDict(object);
    if (!dict) continue;
    const key = asIndex(value(dict, 'StructParent'));
    if (key === undefined) continue;
    const owners = objectOwners.get(key) ?? new Set();
    owners.add(dict);
    objectOwners.set(key, owners);
  }
  for (const [parentKey, usesOfKey] of uses) {
    const owners = new Set(usesOfKey.map(use => use.occurrence.owner));
    if (owners.size + (objectOwners.get(parentKey)?.size ?? 0) < 2) continue;
    for (const { page, occurrence } of usesOfKey) {
      reportIssue(page, 'parent-key', { occurrence, parentKey }, occurrence.spans.filter(s => s.mcid !== undefined));
    }
  }
  for (const page of pages) for (const object of page.objects.values()) {
    const dict = object.object instanceof PDFStream ? object.object.dict : asDict(object.object);
    const parentKey = dict && asIndex(value(dict, 'StructParent'));
    if (parentKey === undefined || (objectOwners.get(parentKey)!.size < 2 && !uses.has(parentKey))) continue;
    object.issues.push(reportIssue(page, 'parent-key', { parentKey, reference: object.reference }));
  }
}
