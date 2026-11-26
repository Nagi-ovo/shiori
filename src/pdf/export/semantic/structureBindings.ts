import { PDFArray, PDFNull, PDFRef, PDFStream } from 'pdf-lib';
import type { PDFDict, PDFObject, PDFPage } from 'pdf-lib';
import type { SemanticDependency } from '../semanticGate';
import { union } from './geometry';
import { replacementKeys, reportIssue } from './markedContent';
import { asDict, asIndex, asText, entry, value } from './pdfValues';
import { isElement } from './structure';
import type { Element, Structure, StructureItem } from './structure';
import type { SemanticObject, SemanticOccurrence, SemanticPage, SemanticSpan } from './types';

type Coverage = { spans: SemanticSpan[]; objects: SemanticObject[] };
type SpanGroup = { spans: SemanticSpan[]; forward: StructureItem[] };
const bbox = ({ spans, objects }: Coverage) => {
  let bounds: SemanticDependency['bbox'];
  for (const scope of [...spans, ...objects]) bounds = union(bounds, scope.bbox);
  return bounds;
};

export function bindStructure(page: PDFPage, result: SemanticPage, tree: Structure): void {
  const resolve = (v: PDFObject | undefined) => page.doc.context.lookup(v);
  const matchesPage = (v: PDFObject | undefined) => resolve(v) === page.node;
  const pageStream = result.occurrences[0]!;
  const groups: SpanGroup[] = [];
  const streams = new Map<PDFObject, Map<number, SpanGroup[]>>();
  const owners = new Map<PDFDict, SemanticOccurrence>();
  const bySpan = new Map<PDFDict, Map<number, SpanGroup[]>>();
  for (const occurrence of result.occurrences) {
    owners.set(occurrence.owner, occurrence);
    let byIndex = bySpan.get(occurrence.owner);
    if (!byIndex) bySpan.set(occurrence.owner, byIndex = new Map());
    for (const span of occurrence.spans) {
      let variants = byIndex.get(span.beginOp);
      if (!variants) byIndex.set(span.beginOp, variants = []);
      let group = variants.find(g => g.spans[0]!.properties === span.properties);
      if (!group) {
        group = { spans: [], forward: [] };
        variants.push(group);
        groups.push(group);
        if (span.mcid !== undefined) addId(occurrence.raw ?? occurrence.owner, span.mcid, group);
      }
      group.spans.push(span);
    }
  }

  function addId(stream: PDFObject, id: number, group: SpanGroup): void {
    let ids = streams.get(stream);
    if (!ids) streams.set(stream, ids = new Map());
    const list = ids.get(id);
    if (list) list.push(group);
    else ids.set(id, [group]);
  }

  const backRefs = new Map<PDFDict, SpanGroup[]>();
  const coverageByElement = new Map<Element, Coverage>();
  const recovered = new Map<PDFDict, Element>();
  const parentKeys = new Map<number, Set<PDFDict>>();
  for (const dict of [...owners.keys(), ...result.objects.keys()].map(o => o instanceof PDFStream ? o.dict : asDict(o))) {
    if (!dict) continue;
    for (const key of ['StructParent', 'StructParents']) {
      const id = asIndex(value(dict, key));
      if (id === undefined) continue;
      let set = parentKeys.get(id);
      if (!set) parentKeys.set(id, set = new Set());
      set.add(dict);
    }
  }

  const addCoverage = (element: Element, spans: SemanticSpan[], object?: SemanticObject) => {
    for (let owner: Element | undefined = element; owner; owner = owner.parent) {
      let cover = coverageByElement.get(owner);
      if (!cover) coverageByElement.set(owner, cover = { spans: [], objects: [] });
      cover.spans.push(...spans);
      if (object) cover.objects.push(object);
      if (owner.issue) for (const span of spans) {
        reportIssue(result, 'structure-entry', { occurrence: span.occurrence, opIndex: span.beginOp, reference: owner.dict }, [span]);
      }
    }
  };

  const elementFor = (raw: PDFObject | undefined) => {
    const dict = asDict(resolve(raw));
    if (!dict || !isElement(dict)) return;
    const known = tree.elements.get(dict) ?? recovered.get(dict);
    if (known) return known;
    const elem = { dict, ref: raw instanceof PDFRef ? raw.toString() : undefined, issue: true };
    recovered.set(dict, elem);
    return elem;
  };

  // First index the reverse edges, including the expected owner of every
  // existing MCID. This gives a broken forward edge a place to attach.
  const reverseOwners = new Map<SpanGroup, Element>();
  for (const [dict, occurrence] of owners) {
    const key = asIndex(value(dict, 'StructParents'));
    const parents = resolve(key === undefined ? undefined : tree.numberTree.values.get(key));
    const ids = streams.get(occurrence.raw ?? dict);
    const badKey = key !== undefined && (tree.numberTree.duplicates.has(key) || parentKeys.get(key)!.size > 1);
    if (parents instanceof PDFArray) {
      for (let mcid = 0; mcid < parents.size(); mcid += 1) {
        const raw = parents.get(mcid);
        if (resolve(raw) === PDFNull) continue;
        const matching = ids?.get(mcid);
        if (!matching) {
          // A dangling slot has a stream address but no covered operators.
          reportIssue(result, 'parent-owner', { occurrence, mcid, parentKey: key, reference: raw });
          continue;
        }
        const owner = elementFor(raw);
        if (!owner) continue;
        for (const group of matching) {
          reverseOwners.set(group, owner);
          const earlier = backRefs.get(owner.dict);
          if (earlier) earlier.push(group);
          else backRefs.set(owner.dict, [group]);
        }
      }
    }
    if (result.tagged && badKey) for (const [mcid, matching] of ids ?? []) for (const group of matching) {
      reportIssue(result, 'parent-key', { occurrence, parentKey: key, mcid }, group.spans);
    }
  }

  const objectsWithReference = new Set<PDFObject>();
  for (const item of tree.items) {
    if (item.type === 'object') {
      const object = resolve(item.object);
      const reachable = object && result.objects.get(object);
      if (reachable && (!item.page || matchesPage(item.page))) {
        if (objectsWithReference.has(reachable.object)) objectIssue(reachable, 'object-mismatch', item.reference);
        objectsWithReference.add(reachable.object);
        addObjectBinding(reachable, item);
      } else if (matchesPage(item.page) || reachable) {
        if (reachable) objectIssue(reachable, 'object-mismatch', item.reference);
        else reportIssue(result, 'object-mismatch', { reference: item.reference });
      }
      continue;
    }
    const raw = resolve(item.stream);
    const reachableForm = raw instanceof PDFStream && owners.get(raw.dict)?.raw === raw;
    if (!matchesPage(item.page) && !reachableForm) continue;
    const explicitPagePart = raw instanceof PDFStream && pageStream.parts.includes(raw) ? raw : undefined;
    const localPage = !item.stream || !!explicitPagePart;
    const addressed = localPage ? pageStream.owner : reachableForm ? raw : undefined;
    const matching = addressed && item.mcid !== undefined ? streams.get(addressed)?.get(item.mcid) : undefined;
    const matches = explicitPagePart ? matching?.filter(group => group.spans[0]!.part === explicitPagePart) : matching;
    const matched = matches?.length ? matches : undefined;
    const byOwner = backRefs.get(item.owner.dict)?.filter(g => g.spans[0]!.mcid === item.mcid);
    const streamOwner = resolve(item.streamOwner);
    const wrongOwner = !!item.streamOwner && (!(raw instanceof PDFStream) || !ownsStream(streamOwner, raw, pageStream));
    if (!matched || wrongOwner || !matchesPage(item.page)) {
      const suspect = matched ?? byOwner;
      if (suspect?.length) for (const group of suspect) {
        for (const span of group.spans) reportIssue(result, 'stream-mismatch', {
          occurrence: span.occurrence, opIndex: span.beginOp, mcid: item.mcid, reference: item.reference,
        }, [span]);
      } else reportIssue(result, 'stream-mismatch', { mcid: item.mcid, reference: item.reference });
      if (item.stream || item.streamOwner) {
        // Expose the address written on the broken edge. Its suspected
        // spans localize refusals, but do not resolve ownership or bounds.
        result.dependencies.push({
          dependency: { kind: 'mcr-stm', source: 'struct-elem', pageIndex: result.pageIndex, mcid: item.mcid,
            stream: item.stream instanceof PDFRef ? item.stream.toString() : undefined, structElem: item.owner.ref },
          spans: suspect?.flatMap(group => group.spans) ?? [], objects: [], owner: item.owner.dict,
          reference: item.reference, unresolved: true,
        });
      }
    } else for (const group of matched) group.forward.push(item);
  }

  const primaryOwner = (group: SpanGroup) => reverseOwners.get(group) ?? group.forward[0]?.owner;
  const ownersBySpan = new Map<SemanticSpan, Element>();
  for (const group of groups) {
    const owner = primaryOwner(group);
    if (owner) for (const span of group.spans) ownersBySpan.set(span, owner);
  }
  for (const group of groups) {
    const first = group.spans[0]!;
    const { occurrence, mcid } = first;
    const reverse = reverseOwners.get(group);
    const inheritedOwners = group.spans.map(span => span.ancestors.findLast(ancestor => ownersBySpan.has(ancestor)))
      .map(span => span && ownersBySpan.get(span));
    const owner = primaryOwner(group) ?? (inheritedOwners.every(elem => elem === inheritedOwners[0])
      ? inheritedOwners[0] : undefined);
    const fields = { pageIndex: result.pageIndex, mcid, stream: occurrence.stream, structElem: owner?.ref,
      bbox: bbox({ spans: group.spans, objects: [] }) };
    if (mcid !== undefined) {
      if (result.tagged && !reverse) {
        reportIssue(result, 'parent-owner', { occurrence, mcid, opIndex: first.beginOp }, group.spans);
      }
      if (group.forward.length > 1 || (reverse && group.forward.every(item => item.owner !== reverse))) {
        reportIssue(result, 'owner-mismatch', { occurrence, mcid, opIndex: first.beginOp }, group.spans);
      }
      result.dependencies.push({ dependency: { ...fields, kind: 'mcid', source: first.source }, spans: group.spans, objects: [], owner: owner?.dict });
    }
    for (const item of group.forward) {
      if (!item.stream && !item.streamOwner) continue;
      result.dependencies.push({
        dependency: { ...fields, structElem: item.owner.ref, kind: 'mcr-stm', source: 'struct-elem' },
        spans: group.spans, objects: [], owner: item.owner.dict, reference: item.reference,
      });
    }
    for (const replacement of first.replacement) result.dependencies.push({
      dependency: { ...fields, kind: replacement.kind, source: first.source, text: replacement.text },
      spans: group.spans, objects: [], owner: owner?.dict, replacementKey: replacement.key,
    });
    const represented = new Set([...(reverse ? [reverse] : []), ...group.forward.map(item => item.owner)]);
    for (const elem of represented) addCoverage(elem, group.spans);
  }

  function addObjectBinding(object: SemanticObject, item?: StructureItem) {
    const dict = object.object instanceof PDFStream ? object.object.dict : asDict(object.object);
    if (!dict) return;
    const key = asIndex(value(dict, 'StructParent'));
    const reverse = elementFor(key === undefined ? undefined : tree.numberTree.values.get(key));
    const owner = item?.owner ?? reverse;
    if (!owner || owner !== reverse || !item || (key !== undefined && (
      tree.numberTree.duplicates.has(key) || parentKeys.get(key)!.size > 1
    ))) {
      objectIssue(object, 'object-mismatch', item?.reference, key);
    }
    result.dependencies.push({
      dependency: { kind: 'objr', source: item ? 'struct-elem' : 'parent-tree', pageIndex: result.pageIndex,
        structElem: owner?.ref, bbox: object.bbox },
      spans: [], objects: [object], owner: owner?.dict, reference: item?.reference,
    });
    if (owner) addCoverage(owner, [], object);
    if (reverse && reverse !== owner) addCoverage(reverse, [], object);
  }

  function objectIssue(object: SemanticObject, kind: 'object-mismatch' | 'property-value', reference?: PDFObject, parentKey?: number): void {
    const at = { parentKey, reference: reference ?? object.reference ?? object.object };
    object.issues.push(reportIssue(result, kind, at));
    for (const paint of object.paints) {
      reportIssue(result, kind, { ...at, occurrence: paint.occurrence, opIndex: paint.opIndex }, paint.spans);
    }
  }

  for (const obj of result.tagged ? result.objects.values() : []) {
    if (objectsWithReference.has(obj.object)) continue;
    const dict = obj.object instanceof PDFStream ? obj.object.dict : asDict(obj.object);
    if (dict && entry(dict, 'StructParent') !== undefined) addObjectBinding(obj);
  }

  for (const [owner, cover] of coverageByElement) {
    const spans = [...new Set(cover.spans)];
    const objects = [...new Set(cover.objects)];
    const first = spans[0];
    const oneScope = !objects.length && first && spans.every(span =>
      span.occurrence.owner === first.occurrence.owner && span.beginOp === first.beginOp);
    for (const [key, kind] of replacementKeys) {
      if (entry(owner.dict, key) === undefined) continue;
      const text = asText(value(owner.dict, key));
      if (text === undefined) {
        for (const span of spans) reportIssue(result, 'property-value', { occurrence: span.occurrence, opIndex: span.beginOp, reference: owner.dict }, [span]);
        for (const object of objects) objectIssue(object, 'property-value', owner.dict);
        continue;
      }
      result.dependencies.push({
        dependency: { kind, source: 'struct-elem', pageIndex: result.pageIndex, structElem: owner.ref, text,
          mcid: oneScope ? first.mcid : undefined, stream: oneScope ? first.occurrence.stream : undefined, bbox: bbox(cover) },
        owner: owner.dict, replacementKey: key, spans, objects,
      });
    }
  }
}

function ownsStream(owner: PDFObject | undefined, stream: PDFStream, page: SemanticOccurrence): boolean {
  if (owner === stream) return true;
  const dict = owner instanceof PDFStream ? owner.dict : asDict(owner);
  if (!dict) return false;
  const references = (raw: PDFObject | undefined) => {
    if (raw === stream) return true;
    return raw instanceof PDFArray && raw.asArray().some((_, index) => raw.lookup(index) === stream);
  };
  if (references(value(dict, 'Contents'))) return true;
  const resources = dict === page.owner ? page.resources : asDict(value(dict, 'Resources'));
  const xobjects = resources && asDict(value(resources, 'XObject'));
  if (xobjects?.entries().some(([, raw]) => xobjects.context.lookup(raw) === stream)) return true;
  // Appearance subdictionaries can either name a stream directly or group
  // streams by appearance state.
  const appearance = asDict(value(dict, 'AP'));
  return appearance?.entries().some(([, raw]) => {
    const v = appearance.context.lookup(raw);
    return v === stream || asDict(v)?.entries().some(([, child]) => appearance.context.lookup(child) === stream);
  }) ?? false;
}
