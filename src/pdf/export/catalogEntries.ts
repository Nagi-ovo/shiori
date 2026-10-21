import {
  PDFDict,
  PDFName,
  type PDFDocument,
  type PDFObject,
  type PDFPage,
  type PDFRef,
} from "pdf-lib";
import {
  asArray,
  copyCatalogEntry,
  isName,
  lookupDict,
  resolveObject,
  seedObjectMapping,
  type CloneState,
} from "./pdfObjectClone";

// Export rebuilds the catalog from scratch (PDFDocument.create), so anything
// not copied here is silently dropped from the user's file. These are the
// entries whose loss is user-visible: /Lang and the structure tree carry
// accessibility, /OpenAction the initial view, /Metadata the XMP twin of the
// Info dict, /PageLabels the front-matter numbering (i, ii, iii...),
// /OCProperties which layers show by default, /ViewerPreferences and
// /PageLayout a right-to-left book's reading direction and spreads.
export function copyDocumentCatalogEntries(
  source: PDFDocument,
  dest: PDFDocument,
  state: CloneState,
  pagesUnchanged: boolean,
) {
  copyCatalogEntry(source, dest, state, "Lang");
  copyCatalogEntry(source, dest, state, "OpenAction");
  copyCatalogEntry(source, dest, state, "Metadata");
  copyOptionalContent(source, dest, state);
  copyCatalogEntry(source, dest, state, "PageLayout");
  if (
    copyCatalogEntry(source, dest, state, "ViewerPreferences") &&
    !pagesUnchanged
  ) {
    // Page numbers for the print dialog, which no longer name these pages.
    dest.catalog
      .lookupMaybe(PDFName.of("ViewerPreferences"), PDFDict)
      ?.delete(PDFName.of("PrintPageRange"));
  }
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

// Page content marks optional content against the layer objects its
// resources name (/OC /name BDC), and /OCProperties says which layers show
// by default. Without it every layer shows, so an answer key hidden on
// screen and in print comes out visible. Visibility is decided by object
// identity, so the layers the copied pages already reference are mapped
// onto their copies first; a fresh clone would hide a different object.
// Annotations name layers too (a widget's /OC, or its appearance's
// resources), so each copied annotation is paired with its source by its
// /Annots position as copyPages left it (recordCopiedAnnotations): later
// passes drop links to left-out pages and append the export's own
// annotations, so the live array no longer lines up with the source.
function copyOptionalContent(
  source: PDFDocument,
  dest: PDFDocument,
  state: CloneState,
) {
  const key = PDFName.of("OCProperties");
  if (!source.catalog.get(key)) return;
  const resourcesKey = PDFName.of("Resources");
  for (const page of source.getPages()) {
    const copied = state.pageRefMap.get(page.ref.toString());
    const destPage = copied && lookupDict(dest, copied);
    if (!destPage) continue;
    seedObjectMapping(
      source,
      dest,
      state,
      page.node.getInheritableAttribute(resourcesKey),
      destPage.get(resourcesKey),
    );
    seedAnnotationLayers(source, dest, state, page.node, copied, destPage);
  }
  copyCatalogEntry(source, dest, state, "OCProperties");
}

const copiedAnnotations = new WeakMap<PDFDocument, Map<string, PDFObject[]>>();

// Call right after copyPages, before anything adds or removes annotations:
// the copier keeps each page's /Annots in source order, one for one.
export function recordCopiedAnnotations(
  dest: PDFDocument,
  copiedPages: readonly PDFPage[],
) {
  const byPage = new Map<string, PDFObject[]>();
  for (const page of copiedPages) {
    const annots = asArray(dest, page.node.get(PDFName.of("Annots")));
    if (annots) byPage.set(page.ref.toString(), annots.asArray());
  }
  copiedAnnotations.set(dest, byPage);
}

function seedAnnotationLayers(
  source: PDFDocument,
  dest: PDFDocument,
  state: CloneState,
  sourcePage: PDFDict,
  destRef: PDFRef,
  destPage: PDFDict,
) {
  const annotsKey = PDFName.of("Annots");
  const subtypeKey = PDFName.of("Subtype");
  const sourceAnnots = asArray(source, sourcePage.get(annotsKey));
  const recorded = copiedAnnotations.get(dest)?.get(destRef.toString());
  const destAnnots = recorded ?? asArray(dest, destPage.get(annotsKey))?.asArray();
  if (!sourceAnnots || !destAnnots) return;
  if (destAnnots.length < sourceAnnots.size()) return;
  for (let index = 0; index < sourceAnnots.size(); index += 1) {
    const from = lookupDict(source, sourceAnnots.get(index));
    const to = lookupDict(dest, destAnnots[index]);
    const subtype = from && resolveName(source, from.get(subtypeKey));
    if (!from || !to || !subtype) continue;
    if (!isName(dest, to.get(subtypeKey), subtype)) continue;
    for (const key of ["OC", "AP"]) {
      const name = PDFName.of(key);
      seedObjectMapping(source, dest, state, from.get(name), to.get(name));
    }
  }
}

function resolveName(
  doc: PDFDocument,
  value: PDFObject | undefined,
): string | undefined {
  const resolved = resolveObject(doc, value);
  return resolved instanceof PDFName ? resolved.decodeText() : undefined;
}
