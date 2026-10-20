import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRef,
  type PDFObject,
} from "pdf-lib";
import {
  asArray,
  cloneObject,
  isName,
  lookupDict,
  type CloneState,
} from "./pdfObjectClone";

const ANNOTS_KEY = PDFName.of("Annots");
const PARENT_KEY = PDFName.of("Parent");
const KIDS_KEY = PDFName.of("Kids");
const SUBTYPE_KEY = PDFName.of("Subtype");

// /AcroForm cannot go through cloneObject: its /Fields point at the widget
// annotations pdf-lib already copied with the pages, so a fresh deep clone
// would produce a second, disconnected copy of every field — the page would
// show one widget while the form dictionary described another. Instead keep
// the form's own settings (/DA, /DR, /NeedAppearances, /SigFlags, /Q) and
// rebuild /Fields from the widgets that actually landed on exported pages.
// Fields whose widgets were not exported drop out, which is the correct
// outcome for a partial export. A whole-document export also keeps the fields
// that have no widget at all (a hidden calculated total), and /CO, the
// calculation order, is rebuilt from the same field objects: a cloned copy
// there is a phantom that gets recalculated while the visible field never is.
export function preserveAcroForm(
  source: PDFDocument,
  dest: PDFDocument,
  state: CloneState,
) {
  const acroFormKey = PDFName.of("AcroForm");
  const sourceForm = lookupDict(source, source.catalog.get(acroFormKey));
  if (!sourceForm) return;

  const copiedFields = mapCopiedFields(source, dest, state);
  const fields = collectFieldRootsFromPages(dest);
  const wholeDocument = source
    .getPages()
    .every((page) => state.pageRefMap.has(page.ref.toString()));
  const sourceFields = asArray(source, sourceForm.get(PDFName.of("Fields")));
  for (let i = 0; wholeDocument && i < (sourceFields?.size() ?? 0); i++) {
    const root = sourceFields!.get(i);
    if (!(root instanceof PDFRef) || copiedFields.has(root.toString())) continue;
    if (holdsWidget(source, root, new Set())) continue;
    const cloned = cloneObject(source, dest, state, root);
    if (!(cloned instanceof PDFRef)) continue;
    copiedFields.set(root.toString(), cloned);
    fields.push(cloned);
  }
  if (fields.length === 0) return;

  const clonedForm = PDFDict.withContext(dest.context);
  for (const [key, value] of sourceForm.entries()) {
    if (key.asString() === "/Fields" || key.asString() === "/CO") continue;
    const cloned = cloneObject(source, dest, state, value);
    if (cloned) clonedForm.set(key, cloned);
  }
  const sourceOrder = asArray(source, sourceForm.get(PDFName.of("CO")));
  const order = PDFArray.withContext(dest.context);
  for (let i = 0; i < (sourceOrder?.size() ?? 0); i++) {
    const entry = sourceOrder!.get(i);
    const copied = entry instanceof PDFRef && copiedFields.get(entry.toString());
    if (copied) order.push(copied);
  }
  if (order.size() > 0) clonedForm.set(PDFName.of("CO"), order);

  const fieldArray = PDFArray.withContext(dest.context);
  for (const ref of fields) fieldArray.push(ref);
  clonedForm.set(PDFName.of("Fields"), fieldArray);
  dest.catalog.set(acroFormKey, clonedForm);
}

// Walks every exported page's /Annots for widget annotations and returns the
// root of each one's field hierarchy (a widget merged with its field is its
// own root). Order follows page order so the rebuilt /Fields reads naturally.
function collectFieldRootsFromPages(dest: PDFDocument): PDFRef[] {
  const roots: PDFRef[] = [];
  const seen = new Set<string>();
  const parentKey = PDFName.of("Parent");
  const subtypeKey = PDFName.of("Subtype");

  for (const page of dest.getPages()) {
    const annots = asArray(dest, page.node.get(ANNOTS_KEY));
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const element = annots.get(i);
      if (!(element instanceof PDFRef)) continue;
      const annot = lookupDict(dest, element);
      if (!annot) continue;
      if (annot.get(subtypeKey)?.toString() !== "/Widget") continue;

      let rootRef: PDFRef = element;
      let current = annot;
      // Bounded walk: a malformed file can point /Parent back at itself.
      const visited = new Set<string>([element.toString()]);
      for (let depth = 0; depth < 32; depth++) {
        const parent = current.get(parentKey);
        if (!(parent instanceof PDFRef)) break;
        const tag = parent.toString();
        if (visited.has(tag)) break;
        visited.add(tag);
        const parentDict = lookupDict(dest, parent);
        if (!parentDict) break;
        rootRef = parent;
        current = parentDict;
      }

      const rootTag = rootRef.toString();
      if (seen.has(rootTag)) continue;
      seen.add(rootTag);
      roots.push(rootRef);
    }
  }

  return roots;
}

// Pairs each exported page's source widgets with the copies pdf-lib made of
// them (the copier keeps /Annots order, and nothing adds or removes widgets
// afterwards), then walks both /Parent chains together, so every field with
// a widget on an exported page maps to the field object the output uses.
// The clone cache learns the same pairs, so nothing cloned later copies a
// field a second time.
function mapCopiedFields(
  source: PDFDocument,
  dest: PDFDocument,
  state: CloneState,
): Map<string, PDFRef> {
  const copied = new Map<string, PDFRef>();
  for (const page of source.getPages()) {
    const destRef = state.pageRefMap.get(page.ref.toString());
    const destPage = destRef && lookupDict(dest, destRef);
    if (!destPage) continue;
    const sourceWidgets = widgetRefs(source, page.node);
    const destWidgets = widgetRefs(dest, destPage);
    if (sourceWidgets.length !== destWidgets.length) continue;
    sourceWidgets.forEach((sourceWidget, index) => {
      let from: PDFRef | undefined = sourceWidget;
      let to: PDFRef | undefined = destWidgets[index];
      for (let depth = 0; from && to && depth < 32; depth++) {
        const tag = from.toString();
        if (copied.has(tag)) break;
        copied.set(tag, to);
        if (!state.clonedRefs.has(tag)) state.clonedRefs.set(tag, to);
        const fromParent: PDFObject | undefined = lookupDict(source, from)?.get(PARENT_KEY);
        const toParent: PDFObject | undefined = lookupDict(dest, to)?.get(PARENT_KEY);
        from = fromParent instanceof PDFRef ? fromParent : undefined;
        to = toParent instanceof PDFRef ? toParent : undefined;
      }
    });
  }
  return copied;
}

function widgetRefs(doc: PDFDocument, page: PDFDict): PDFRef[] {
  const annots = asArray(doc, page.get(ANNOTS_KEY));
  const widgets: PDFRef[] = [];
  for (let i = 0; i < (annots?.size() ?? 0); i++) {
    const entry = annots!.get(i);
    const annot = lookupDict(doc, entry);
    if (entry instanceof PDFRef && isName(doc, annot?.get(SUBTYPE_KEY), "Widget")) {
      widgets.push(entry);
    }
  }
  return widgets;
}

function holdsWidget(
  doc: PDFDocument,
  node: PDFRef | PDFDict | undefined,
  visited: Set<PDFDict>,
): boolean {
  const dict = lookupDict(doc, node);
  if (!dict || visited.has(dict)) return false;
  visited.add(dict);
  if (isName(doc, dict.get(SUBTYPE_KEY), "Widget")) return true;
  const kids = asArray(doc, dict.get(KIDS_KEY));
  for (let i = 0; i < (kids?.size() ?? 0); i++) {
    const kid = kids!.get(i);
    if (
      (kid instanceof PDFRef || kid instanceof PDFDict) &&
      holdsWidget(doc, kid, visited)
    ) {
      return true;
    }
  }
  return false;
}
