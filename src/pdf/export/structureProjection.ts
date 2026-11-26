import { PDFArray, PDFBool, PDFDict, PDFHexString, PDFName, PDFNull, PDFNumber, PDFRef, PDFStream, PDFString } from 'pdf-lib';
import type { PDFDocument, PDFObject, PDFPage } from 'pdf-lib';
import { createSemanticInspector } from './semantic/inspection';
import { asDict, asIndex, asName, entry, numberArray, value } from './semantic/pdfValues';
import { readStructureEdges, type StructureItem } from './semantic/structure';
import type { SemanticPage } from './semantic/types';
import type { CloneState } from './pdfObjectClone';

const name = PDFName.of;

/** Observe Original only's removals before any pass changes the source /Annots. */
export function observeAnnotationRemoval(source: PDFDocument): ReadonlySet<PDFDict> | undefined {
  if (!asDict(value(source.catalog, 'StructTreeRoot'))) return;
  const members = new Map<PDFDict, { raw: PDFObject; page: PDFPage; index: number } | undefined>();
  for (const [index, page] of source.getPages().entries()) {
    const annots = value(page.node, 'Annots');
    if (!(annots instanceof PDFArray)) continue;
    for (const raw of annots.asArray()) {
      const object = asDict(source.context.lookup(raw));
      if (object) members.set(object, members.has(object) ? undefined : { raw, page, index });
    }
  }
  if (!members.size) return;

  // Even an empty set signals that a preceding file-omission pass may have
  // emptied /Annots, so copying the whole source tree could revive an OBJR.
  const removed = new Set<PDFDict>();
  const inspector = createSemanticInspector(source, { images: true });
  const { objects } = readStructureEdges(source, inspector.structure);
  const cycles = new Set(inspector.structure.issues.filter(issue => issue.kind === 'structure-cycle')
    .map(issue => source.context.lookup(issue.reference)));
  for (const [object, member] of members) {
    if (!member || !(member.raw instanceof PDFRef)) continue;
    const type = value(object, 'Type');
    if (!asName(value(object, 'Subtype')) || (type === undefined
      ? !numberArray(value(object, 'Rect'), 4) : type !== name('Annot'))) continue;
    const items = objects.get(object);
    if (items?.length !== 1) continue;
    const item = items[0]!;
    const declaredPage = entry(object, 'P');
    if (!item.reference || item.object !== member.raw || source.context.lookup(item.page) !== member.page.node ||
        (declaredPage !== undefined && source.context.lookup(declaredPage) !== member.page.node)) continue;
    let owner: StructureItem['owner'] | undefined = item.owner;
    while (owner && !owner.issue && !cycles.has(owner.dict)) owner = owner.parent;
    if (owner) continue;
    // Check the forward and reverse witnesses, including document-wide
    // StructParent key collisions, against the same unmodified source.
    if (boundAddress(inspector.inspectDocument()[member.index]!, item)?.owner === object) removed.add(item.reference);
  }
  return removed;
}

// Rebuild the forward and reverse edges together. Only a bound source item
// with a single destination page and an address in its copied graph survives.
export function projectStructureTree(
  source: PDFDocument, dest: PDFDocument, state: CloneState, copies: readonly PDFPage[],
  settleNavigation: () => void, removedAnnotationKids?: ReadonlySet<PDFDict>,
): void {
  const original = asDict(value(source.catalog, 'StructTreeRoot'));
  if (!original) return;
  const inspector = createSemanticInspector(source, { images: true });
  const structure = inspector.structure;
  const retained = new Map<PDFDict, { index: number; ref: PDFRef }>(source.getPages().flatMap((page, index) => {
    const ref = state.pageRefMap.get(page.ref.toString());
    return ref ? [[page.node, { index, ref }] as const] : [];
  }));
  const inspected = inspector.inspectDocument();
  const annotations = new Map(copies.map(page => [page.ref, annotationRefs(page)]));
  const rootRef = dest.context.nextRef();
  const contentOwners = new Set<PDFObject>();
  const objectOwners = new Set<PDFObject>();
  const parents = new Map<number, PDFRef | Map<number, PDFRef>>();
  function mappedPage(raw: PDFObject | undefined) {
    const node = asDict(source.context.lookup(raw));
    return node && retained.get(node);
  }
  const mappedRef = (raw: PDFObject | undefined) => {
    if (!(raw instanceof PDFRef)) return;
    const tag = raw.toString();
    return state.sourcePageRefTags.has(tag) ? state.pageRefMap.get(tag) : state.clonedRefs.get(tag);
  };
  // Match against both snapshots so only navigation removals count as
  // deliberate omissions, while OBJRs name the final annotation refs.
  const liveLinks = new Map<PDFRef, Set<PDFObject>>();
  if (structure.items.some(item => {
    if (item.type !== 'object' || item.owner.issue) return false;
    const page = mappedPage(item.page);
    const object = asDict(source.context.lookup(item.object));
    const ref = mappedRef(item.object);
    return !!page && !!object && asName(value(object, 'Subtype')) === 'Link' &&
      !!ref && !!annotations.get(page.ref)?.has(ref) && !!boundAddress(inspected[page.index]!, item);
  })) {
    settleNavigation();
    for (const page of copies) liveLinks.set(page.ref, annotationRefs(page));
  }

  const itemsByOwner = new Map<PDFDict, Map<PDFObject | number, StructureItem>>();
  for (const item of structure.items) {
    const key = item.reference ?? item.mcid;
    if (key === undefined) continue;
    let items = itemsByOwner.get(item.owner.dict);
    if (!items) itemsByOwner.set(item.owner.dict, items = new Map());
    items.set(key, item);
  }

  type Kid = { raw?: PDFObject; complete: boolean };
  const excluded: Kid = { complete: false };
  const removed: Kid = { complete: true };

  function copyItem(item: StructureItem, parent: PDFRef): Kid {
    const page = mappedPage(item.page);
    if (!page) return excluded;
    if (item.type === 'object' && item.reference && removedAnnotationKids?.has(item.reference)) return removed;
    const result = inspected[page.index]!;
    const address = boundAddress(result, item);
    if (!address) return excluded;
    const { key, mcid } = address;
    const liveOwner = state.clonedObjects.get(address.owner);
    if (!liveOwner) return excluded;
    const previous = parents.get(key);
    if (mcid === undefined ? previous !== undefined :
      previous instanceof PDFRef || previous?.has(mcid)) return excluded;
    const reference = item.reference;
    if (!reference) {
      if (mcid === undefined) return excluded;
      putParent(key, parent, mcid);
      contentOwners.add(liveOwner);
      return { raw: PDFNumber.of(mcid), complete: true };
    }
    const copy = dest.context.obj({ Type: item.type === 'object' ? 'OBJR' : 'MCR', Pg: page.ref });
    if (mcid !== undefined) copy.set(name('MCID'), PDFNumber.of(mcid));
    for (const key of ['Stm', 'StmOwn', 'Obj']) {
      const raw = entry(reference, key);
      if (raw === undefined) continue;
      const ref = mappedRef(raw);
      if (!ref || !dest.context.lookup(ref)) return excluded;
      copy.set(name(key), ref);
    }
    if (item.type === 'object' && liveOwner instanceof PDFDict && asName(value(liveOwner, 'Subtype')) === 'Link') {
      const ref = entry(copy, 'Obj');
      const live = liveLinks.get(page.ref);
      if (!live || !ref || dest.context.lookup(ref) !== liveOwner || !annotations.get(page.ref)?.has(ref)) return excluded;
      if (!live.has(ref)) return removed;
    }
    const ref = dest.context.register(copy);
    state.clonedObjects.set(reference, copy);
    putParent(key, parent, mcid);
    (mcid === undefined ? objectOwners : contentOwners).add(liveOwner);
    return { raw: ref, complete: true };
  }

  function putParent(key: number, parent: PDFRef, mcid: number | undefined): void {
    if (mcid === undefined) {
      parents.set(key, parent);
    } else {
      let slots = parents.get(key);
      if (!(slots instanceof Map)) parents.set(key, slots = new Map());
      slots.set(mcid, parent);
    }
  }

  const seen = new Set<PDFObject>();
  function projectKid(raw: PDFObject | undefined, parent: PDFRef, owner?: PDFDict, depth = 0): Kid {
    const child = source.context.lookup(raw);
    if (!child || child === PDFNull || depth >= 128) return excluded;
    if (child instanceof PDFArray) {
      if (seen.has(child)) return excluded;
      seen.add(child);
      const kids = child.asArray().map(k => projectKid(k, parent, owner, depth + 1));
      const kept = kids.flatMap(k => k.raw ? [k.raw] : []);
      return { raw: kept.length ? dest.context.obj(kept) : undefined,
        complete: kids.length > 0 && kids.every(k => k.complete) };
    }
    const itemKey = child instanceof PDFDict ? child : asIndex(child);
    const item = owner && itemKey !== undefined && itemsByOwner.get(owner)?.get(itemKey);
    if (item) return copyItem(item, parent);
    if (!(child instanceof PDFDict) || seen.has(child)) return excluded;
    const element = structure.elements.get(child);
    if (!element || element.issue || element.parent?.dict !== owner) return excluded;
    seen.add(child);
    const ref = dest.context.nextRef();
    const kids = projectKid(entry(child, 'K'), ref, child, depth + 1);
    const originalPage = entry(child, 'Pg');
    const page = mappedPage(originalPage);
    const complete = kids.complete && (originalPage === undefined || !!page);
    if (!kids.raw) return { complete };
    const copy = dest.context.obj({ Type: 'StructElem', P: parent, K: kids.raw });
    if (page) copy.set(name('Pg'), page.ref);
    // A label on a mixed subtree can disclose the text of an omitted child.
    // Indirect attributes, class names and IDs are deliberately not projected.
    for (const key of complete ? ['S', 'Lang', 'R', 'T', 'ActualText', 'Alt', 'E'] : ['S', 'Lang', 'R']) {
      const field = value(child, key);
      if (field instanceof PDFName || field instanceof PDFNumber || field instanceof PDFString || field instanceof PDFHexString) {
        copy.set(name(key), field.clone());
      }
    }
    dest.context.assign(ref, copy);
    state.clonedObjects.set(child, copy);
    return { raw: ref, complete };
  }

  const kids = projectKid(entry(original, 'K'), rootRef);
  // The copied pages, streams and annotations carry their original keys.
  // Clear the keys without a projected reverse edge on that exact object.
  for (const page of copies) {
    if (!contentOwners.has(page.node)) page.node.delete(name('StructParents'));
    for (const raw of annotations.get(page.ref) ?? []) {
      const annot = asDict(dest.context.lookup(raw));
      if (annot && !objectOwners.has(annot)) annot.delete(name('StructParent'));
    }
  }
  for (const [, stream] of dest.context.enumerateIndirectObjects()) {
    if (!(stream instanceof PDFStream)) continue;
    if (!contentOwners.has(stream.dict)) stream.dict.delete(name('StructParents'));
    if (!objectOwners.has(stream)) stream.dict.delete(name('StructParent'));
  }
  if (!kids.raw) return;
  const nums = PDFArray.withContext(dest.context);
  for (const [key, slots] of [...parents].sort(([a], [b]) => a - b)) {
    nums.push(PDFNumber.of(key));
    if (slots instanceof PDFRef) nums.push(slots);
    else {
      const owners = PDFArray.withContext(dest.context);
      let last = 0;
      for (const mcid of slots.keys()) last = Math.max(last, mcid);
      for (let i = 0; i <= last; i++) owners.push(slots.get(i) ?? PDFNull);
      nums.push(owners);
    }
  }
  const root = dest.context.obj({ Type: 'StructTreeRoot', K: kids.raw, ParentTree: { Nums: nums } });
  const roleMap = asDict(value(original, 'RoleMap'));
  if (roleMap) {
    const roles = PDFDict.withContext(dest.context);
    for (const [key, raw] of roleMap.entries()) {
      const role = roleMap.context.lookup(raw);
      if (role instanceof PDFName) roles.set(key, role);
    }
    root.set(name('RoleMap'), roles);
  }
  dest.context.assign(rootRef, root);
  dest.catalog.set(name('StructTreeRoot'), rootRef);
  const markInfo = asDict(value(source.catalog, 'MarkInfo'));
  if (markInfo) {
    const marks = PDFDict.withContext(dest.context);
    for (const key of ['Marked', 'Suspects', 'UserProperties']) {
      const flag = value(markInfo, key);
      if (flag instanceof PDFBool) marks.set(name(key), flag);
    }
    dest.catalog.set(name('MarkInfo'), marks);
  }
}

function annotationRefs(page: PDFPage): Set<PDFObject> {
  const annotations = value(page.node, 'Annots');
  return new Set(annotations instanceof PDFArray ? annotations.asArray() : []);
}

function boundAddress(page: SemanticPage, item: StructureItem): { key: number; owner: PDFObject; mcid?: number } | undefined {
  if (item.type === 'object') {
    const binding = page.dependencies.find(b => b.dependency.kind === 'objr' &&
      b.owner === item.owner.dict && b.reference === item.reference);
    const object = binding?.objects[0];
    if (!object || object.issues.length) return;
    const dict = object.object instanceof PDFStream ? object.object.dict : asDict(object.object);
    if (!dict || (object.object instanceof PDFStream && asName(value(dict, 'Subtype')) === 'Link')) return;
    const key = asIndex(value(dict, 'StructParent'));
    if (key !== undefined) return { key, owner: object.object };
    return;
  }
  const mcid = item.mcid;
  if (mcid === undefined) return;
  const explicit = item.stream || item.streamOwner;
  const binding = page.dependencies.find(b => b.dependency.kind === (explicit ? 'mcr-stm' : 'mcid') &&
    b.dependency.mcid === mcid && b.owner === item.owner.dict &&
    (explicit ? b.reference === item.reference : b.spans[0]?.occurrence === page.occurrences[0]));
  const span = binding?.spans[0];
  if (!binding || !span || binding.unresolved || binding.spans.some(s => s.issues.some(issue => issue.kind !== 'coverage'))) return;
  if (item.streamOwner) {
    const owner = span.occurrence.owner.context.lookup(item.streamOwner);
    if (!owner || !page.occurrences.some(occurrence => occurrence.owner === owner || occurrence.raw === owner)) return;
  }
  const owner = span.occurrence.owner;
  const key = asIndex(value(owner, 'StructParents'));
  if (key !== undefined) return { key, owner, mcid };
}
