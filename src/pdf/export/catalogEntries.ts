import type { PDFDocument } from "pdf-lib";
import { copyCatalogEntry, type CloneState } from "./pdfObjectClone";

// Export rebuilds the catalog from scratch (PDFDocument.create), so anything
// not copied here is silently dropped from the user's file. These are the
// entries whose loss is user-visible: /Lang and the structure tree carry
// accessibility, /OpenAction the initial view, /Metadata the XMP twin of the
// Info dict, /PageLabels the front-matter numbering (i, ii, iii...).
export function copyDocumentCatalogEntries(
  source: PDFDocument,
  dest: PDFDocument,
  state: CloneState,
  pagesUnchanged: boolean,
) {
  copyCatalogEntry(source, dest, state, "Lang");
  copyCatalogEntry(source, dest, state, "OpenAction");
  copyCatalogEntry(source, dest, state, "Metadata");
  if (pagesUnchanged) {
    copyCatalogEntry(source, dest, state, "PageLabels");
    // /MarkInfo without /StructTreeRoot advertises a tagged PDF that has no
    // tags, which is worse for assistive tech than an untagged file, so the
    // two move together.
    if (copyCatalogEntry(source, dest, state, "StructTreeRoot")) {
      copyCatalogEntry(source, dest, state, "MarkInfo");
    }
  }
}
