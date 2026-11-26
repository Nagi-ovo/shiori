import { PDFName } from 'pdf-lib';
import type { PDFDict, PDFDocument, PDFObject, PDFPage, PDFRef } from 'pdf-lib';
import type { PageModel } from '../model/types';
import { copyCatalogEntry, createCloneState, seedObjectMapping } from './pdfObjectClone';
import { projectStructureTree } from './structureProjection';
import type { CloneState } from './pdfObjectClone';

const structRoot = PDFName.of('StructTreeRoot');
const resources = PDFName.of('Resources');
const installedStructureObjects = new WeakMap<PDFDocument, CloneState>();
const projected = new WeakSet<PDFDocument>();
const copiedStructureObjects = new WeakMap<PDFDocument, CloneState>();

export function prepareStructureNavigation(
  pages: readonly PageModel[],
  placePage: (page: PageModel) => PDFPage,
  retainedRefs: (page: PageModel, copy: PDFPage) => ReadonlyMap<string, PDFRef> | undefined,
  preserveNavigation: () => void,
) {
  // Record the annotation positions before navigation can remove links.
  const placed = pages.map(page => {
    const inserted = placePage(page);
    return { inserted, retained: retainedRefs(page, inserted) };
  });
  preserveNavigation();
  // Writers can append to an already normalized page after pruning emptied it.
  for (const { inserted: { node, doc } } of placed) {
    if (!node.has(PDFName.Annots)) node.set(PDFName.Annots, doc.context.obj([]));
  }
  return {
    placed,
    finish() {
      for (const { inserted: { node } } of placed) {
        if (node.Annots()?.size() === 0) node.delete(PDFName.Annots);
      }
    },
  };
}

/**
 * Pair the source and destination objects while copyPages' edges still line
 * up. Later draws may append to /Contents or /Annots, or replace a resource.
 * A structure reference must keep naming the original copied object.
 */
export function recordCopiedStructureObjects(
  source: PDFDocument, dest: PDFDocument, indices: number[], copied: readonly PDFPage[], removedAnnotations: boolean,
  settleNavigation: () => ReturnType<typeof prepareStructureNavigation>, removedAnnotationKids?: ReadonlySet<PDFDict>,
) {
  if (!source.catalog.has(structRoot)) return;
  const pages = source.getPages();
  const counts = new Map<number, number>();
  for (const index of indices) counts.set(index, (counts.get(index) ?? 0) + 1);
  const state = createCloneState(source, new Map());
  const pairs = copied.flatMap((to, position) => {
    const index = indices[position]!;
    if (counts.get(index) !== 1) return [];
    const from = pages[index]!;
    state.pageRefMap.set(from.ref.toString(), to.ref);
    state.clonedObjects.set(from.node, to.node);
    return [{ from, to }];
  });
  for (const { from, to } of pairs) {
    seedObjectMapping(source, dest, state, from.node.getInheritableAttribute(resources), to.node.get(resources));
    for (const key of [PDFName.of('Contents'), PDFName.of('Annots')]) {
      seedObjectMapping(source, dest, state, from.node.get(key), to.node.get(key));
    }
  }
  copiedStructureObjects.set(dest, state);
  if (pairs.length === pages.length && !removedAnnotations && !removedAnnotationKids) return;
  projected.add(dest);
  let settled: ReturnType<typeof prepareStructureNavigation> | undefined;
  projectStructureTree(source, dest, state, copied, () => { settled = settleNavigation(); }, removedAnnotationKids);
  return settled;
}

export function structureWasProjected(dest: PDFDocument): boolean {
  return projected.has(dest);
}

export function copyStructureTree(source: PDFDocument, dest: PDFDocument, state: CloneState): boolean {
  if (state.pageRefMap.size !== state.sourcePageRefTags.size || structureWasProjected(dest)) return false;
  const recorded = copiedStructureObjects.get(dest);
  // Restrict the additional seeds to the structure copy so unrelated
  // catalog passes retain their existing cloning behavior.
  const mapping = recorded ? {
    ...state,
    clonedRefs: new Map([...state.clonedRefs, ...recorded.clonedRefs]),
    clonedObjects: new Map([...state.clonedObjects, ...recorded.clonedObjects]),
  } : state;
  if (!copyCatalogEntry(source, dest, mapping, 'StructTreeRoot')) return false;
  installedStructureObjects.set(dest, mapping);
  return true;
}

export function copiedSemanticObject(dest: PDFDocument, object: PDFObject): PDFObject | undefined {
  return installedStructureObjects.get(dest)?.clonedObjects.get(object)
    ?? copiedStructureObjects.get(dest)?.clonedObjects.get(object);
}
