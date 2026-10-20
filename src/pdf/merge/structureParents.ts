import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { lookupArray, lookupDict } from "./pdfObjects";

/**
 * Page insertion copies pages, not the incoming structure tree, so an
 * inserted page's /StructParents (and its annotations' /StructParent) would
 * index into the base document's ParentTree and hand its marked content to
 * unrelated base structure elements. Untagged is honest; aliased is not.
 */
export function dropStructureParents(document: PDFDocument, page: PDFDict) {
  page.delete(PDFName.of("StructParents"));
  const annots = lookupArray(document, page.get(PDFName.of("Annots")));
  if (!annots) return;
  for (let index = 0; index < annots.size(); index += 1) {
    lookupDict(document, annots.get(index))?.delete(PDFName.of("StructParent"));
  }
}
