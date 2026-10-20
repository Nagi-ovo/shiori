// Keeps copyPages from pulling pages into an export through references.
//
// pdf-lib's copier follows every reference it meets except a page's own
// /Parent. Any other path to a page object (an annotation's /P, a GoTo action,
// an article bead, a form field whose other widget sits on another page)
// therefore copies that whole page, content stream and resources included, as
// an object outside the output page tree. A viewer never shows it, but the
// bytes are in the file: a "current page only" export of a form used to carry
// every page the form touched. Even a whole-document export carried a stray
// duplicate of each page an annotation's /P named.
//
// Before the copy, every reference from an exported page's object graph to a
// page object is swapped for a marker object naming the target. After the
// pages are inserted, each marker reference becomes the page that was really
// exported (pdf-lib cannot be told which copy that is), or is dropped when the
// target page is not part of the export. The source is restored right after
// copyPages so the catalog passes that run later see the original references.
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNull,
  PDFObject,
  PDFRef,
  PDFStream,
  PDFString,
} from "pdf-lib";
import { asArray, isName, lookupDict, resolveObject } from "./pdfObjectClone";

const MARKER_KEY = PDFName.of("ShioriExportPageRef");
const PARENT_KEY = PDFName.of("Parent");
const ANNOTS_KEY = PDFName.of("Annots");
const SUBTYPE_KEY = PDFName.of("Subtype");
const KIDS_KEY = PDFName.of("Kids");

type Container = PDFDict | PDFArray;
type Slot = { container: Container; key: PDFName | number; original: PDFRef };

export type PageIsolation = {
  /** Put the original page references back into the source. */
  restoreSource(): void;
  /** Point the copied references at the exported pages, or drop them. */
  resolve(dest: PDFDocument, pageRefMap: ReadonlyMap<string, PDFRef>): void;
};

export function isolatePageReferences(
  source: PDFDocument,
  exportedSourceIndices: readonly number[],
): PageIsolation {
  const pages = source.getPages();
  const exported = [...new Set(exportedSourceIndices)]
    .map((index) => pages[index])
    .filter((page) => page !== undefined);
  if (exported.length < pages.length) {
    pruneLinksToUnexportedAnnotations(
      source,
      exported.map((page) => page.node),
    );
  }

  const pageTags = new Set(pages.map((page) => page.ref.toString()));
  const pageLike = new Map<string, boolean>();
  const isPageRef = (ref: PDFRef): boolean => {
    const tag = ref.toString();
    if (pageTags.has(tag)) return true;
    let known = pageLike.get(tag);
    if (known === undefined) {
      known = isPageObject(source, ref);
      pageLike.set(tag, known);
    }
    return known;
  };

  const markers = new Map<string, PDFRef>();
  const markerFor = (target: PDFRef): PDFRef => {
    const tag = target.toString();
    let marker = markers.get(tag);
    if (!marker) {
      marker = source.context.register(
        source.context.obj({ [MARKER_KEY.decodeText()]: PDFString.of(tag) }),
      );
      markers.set(tag, marker);
    }
    return marker;
  };

  const slots: Slot[] = [];
  const pending: Container[] = [];
  const seen = new Set<PDFObject>();
  const seenRefs = new Set<string>();
  const enqueue = (value: PDFObject | undefined) => {
    const resolved =
      value instanceof PDFRef ? resolveObject(source, value) : value;
    const container =
      resolved instanceof PDFStream ? resolved.dict : resolved;
    if (
      (container instanceof PDFDict || container instanceof PDFArray) &&
      !seen.has(container)
    ) {
      seen.add(container);
      pending.push(container);
    }
  };
  const consider = (
    container: Container,
    key: PDFName | number,
    value: PDFObject | undefined,
  ) => {
    if (!(value instanceof PDFRef)) {
      enqueue(value);
      return;
    }
    if (isPageRef(value)) {
      slots.push({ container, key, original: value });
      setSlot(container, key, markerFor(value));
      return;
    }
    const tag = value.toString();
    if (seenRefs.has(tag)) return;
    seenRefs.add(tag);
    enqueue(value);
  };

  for (const page of exported) {
    seen.add(page.node);
    for (const [key, value] of page.node.entries()) {
      if (key !== PARENT_KEY) consider(page.node, key, value);
    }
    // The copier also folds inherited /Resources into the copied page.
    enqueue(page.node.Resources());
  }
  while (pending.length > 0) {
    const container = pending.pop()!;
    if (container instanceof PDFDict) {
      for (const [key, value] of container.entries()) {
        consider(container, key, value);
      }
    } else {
      for (let index = 0; index < container.size(); index += 1) {
        consider(container, index, container.get(index));
      }
    }
  }

  return {
    restoreSource() {
      for (const slot of slots) setSlot(slot.container, slot.key, slot.original);
      for (const marker of markers.values()) source.context.delete(marker);
    },
    resolve(dest, pageRefMap) {
      if (markers.size === 0) return;
      resolveMarkers(dest, pageRefMap);
    },
  };
}

function resolveMarkers(
  dest: PDFDocument,
  pageRefMap: ReadonlyMap<string, PDFRef>,
) {
  const targets = new Map<string, PDFRef | null>();
  const markerRefs: PDFRef[] = [];
  for (const [ref, object] of dest.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) continue;
    const target = object.get(MARKER_KEY);
    if (!(target instanceof PDFString)) continue;
    markerRefs.push(ref);
    targets.set(ref.toString(), pageRefMap.get(target.decodeText()) ?? null);
  }
  if (markerRefs.length === 0) return;

  const rewrite = (object: PDFObject) => {
    const container = object instanceof PDFStream ? object.dict : object;
    if (container instanceof PDFDict) {
      for (const [key, value] of container.entries()) {
        if (value instanceof PDFRef && targets.has(value.toString())) {
          const page = targets.get(value.toString());
          if (page) container.set(key, page);
          else container.delete(key);
        } else {
          rewrite(value);
        }
      }
    } else if (container instanceof PDFArray) {
      for (let index = 0; index < container.size(); index += 1) {
        const value = container.get(index);
        if (value instanceof PDFRef && targets.has(value.toString())) {
          container.set(index, targets.get(value.toString()) ?? PDFNull);
        } else {
          rewrite(value);
        }
      }
    }
  };
  for (const [, object] of dest.context.enumerateIndirectObjects()) {
    rewrite(object);
  }
  for (const ref of markerRefs) dest.context.delete(ref);
}

// In a partial export, annotations on exported pages may still name
// annotations that live only on pages being left out: a reply's /IRT, a
// popup's /Parent or /Popup, and above all a form field's /Kids, whose other
// widgets (and sibling fields, with their values) belong to other pages. The
// page references are cut above; these edges would still carry the left-out
// annotations themselves, so they are removed from the throwaway source.
function pruneLinksToUnexportedAnnotations(
  source: PDFDocument,
  exportedPages: readonly PDFDict[],
) {
  const exportedAnnots = new Set<string>();
  const annots: PDFDict[] = [];
  for (const page of exportedPages) {
    const entries = asArray(source, page.get(ANNOTS_KEY));
    for (let index = 0; index < (entries?.size() ?? 0); index += 1) {
      const entry = entries!.get(index);
      if (entry instanceof PDFRef) exportedAnnots.add(entry.toString());
      const annot = lookupDict(source, entry);
      if (annot) annots.push(annot);
    }
  }
  const leftOut = (value: PDFObject | undefined) =>
    value instanceof PDFRef && !exportedAnnots.has(value.toString());

  const fieldRoots = new Set<PDFObject>();
  for (const annot of annots) {
    for (const key of ["IRT", "Popup"]) {
      if (leftOut(annot.get(PDFName.of(key)))) annot.delete(PDFName.of(key));
    }
    if (isName(source, annot.get(SUBTYPE_KEY), "Popup")) {
      if (leftOut(annot.get(PARENT_KEY))) annot.delete(PARENT_KEY);
    } else if (isName(source, annot.get(SUBTYPE_KEY), "Widget")) {
      fieldRoots.add(fieldRoot(source, annot));
    }
  }

  // A field node stays when it is, or holds, a widget on an exported page.
  const visited = new Set<PDFObject>();
  const keep = (node: PDFObject | undefined): boolean => {
    if (node instanceof PDFRef && exportedAnnots.has(node.toString())) {
      return true;
    }
    const dict = lookupDict(source, node);
    if (!dict || visited.has(dict)) return false;
    visited.add(dict);
    const kids = asArray(source, dict.get(KIDS_KEY));
    if (!kids) return false;
    let kept = false;
    for (let index = kids.size() - 1; index >= 0; index -= 1) {
      if (keep(kids.get(index))) kept = true;
      else kids.remove(index);
    }
    return kept;
  };
  for (const root of fieldRoots) {
    const dict = lookupDict(source, root);
    const kids = dict && asArray(source, dict.get(KIDS_KEY));
    for (let index = (kids?.size() ?? 0) - 1; index >= 0; index -= 1) {
      if (!keep(kids!.get(index))) kids!.remove(index);
    }
  }
}

function fieldRoot(source: PDFDocument, widget: PDFDict): PDFDict {
  let current = widget;
  const visited = new Set<PDFDict>([widget]);
  for (let depth = 0; depth < 32; depth += 1) {
    const parent = lookupDict(source, current.get(PARENT_KEY));
    if (!parent || visited.has(parent)) break;
    visited.add(parent);
    current = parent;
  }
  return current;
}

function isPageObject(source: PDFDocument, ref: PDFRef): boolean {
  const object = lookupDict(source, ref);
  const type = object?.get(PDFName.of("Type"));
  return isName(source, type, "Page") || isName(source, type, "Pages");
}

function setSlot(container: Container, key: PDFName | number, value: PDFObject) {
  if (container instanceof PDFDict) container.set(key as PDFName, value);
  else container.set(key as number, value);
}
