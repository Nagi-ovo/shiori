import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef } from "pdf-lib";
import {
  asArray,
  cloneObject,
  lookupDict,
  type CloneState,
} from "./pdfObjectClone";

const ANNOTS_KEY = PDFName.of("Annots");

// /AcroForm cannot go through cloneObject: its /Fields point at the widget
// annotations pdf-lib already copied with the pages, so a fresh deep clone
// would produce a second, disconnected copy of every field — the page would
// show one widget while the form dictionary described another. Instead keep
// the form's own settings (/DA, /DR, /NeedAppearances, /SigFlags, /Q) and
// rebuild /Fields from the widgets that actually landed on exported pages.
// Fields whose widgets were not exported drop out, which is the correct
// outcome for a partial export.
export function preserveAcroForm(
  source: PDFDocument,
  dest: PDFDocument,
  state: CloneState,
) {
  const acroFormKey = PDFName.of("AcroForm");
  const sourceForm = lookupDict(source, source.catalog.get(acroFormKey));
  if (!sourceForm) return;

  const fields = collectFieldRootsFromPages(dest);
  if (fields.length === 0) return;

  const clonedForm = PDFDict.withContext(dest.context);
  for (const [key, value] of sourceForm.entries()) {
    if (key.asString() === "/Fields") continue;
    const cloned = cloneObject(source, dest, state, value);
    if (cloned) clonedForm.set(key, cloned);
  }

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
