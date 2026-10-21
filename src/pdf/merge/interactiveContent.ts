import {
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFString,
} from "pdf-lib";
import {
  lookupArray,
  lookupDict,
  resolveObject,
} from "./pdfObjects";

const INTERACTIVE_ANNOTATION_SUBTYPES = new Set([
  "Widget",
  "Screen",
  "Movie",
  "Sound",
  "RichMedia",
  "3D",
]);
const SAFE_URI_SCHEME = /^(?:https?|mailto):/i;

/**
 * Page insertion must not turn content that Shiori only rendered inertly into
 * active content in somebody else's PDF viewer. Catalog JavaScript is already
 * excluded by exportPdf(), but page and annotation actions are reachable from
 * copyPages(). Keep ordinary internal and web links; fail closed for forms,
 * media, launch/JavaScript actions and additional-action triggers.
 */
export function hasUnsupportedInteractiveContent(document: PDFDocument): boolean {
  if (
    hasFormStructures(document) ||
    document.catalog.get(PDFName.of("Perms"))
  ) {
    return true;
  }
  for (const page of document.getPages()) {
    if (page.node.get(PDFName.of("AA"))) return true;
    const annots = lookupArray(document, page.node.get(PDFName.of("Annots")));
    if (!annots) continue;
    for (let index = 0; index < annots.size(); index += 1) {
      const annot = lookupDict(document, annots.get(index));
      if (!annot) continue;
      const subtype = resolveObject(document, annot.get(PDFName.of("Subtype")));
      if (
        subtype instanceof PDFName &&
        INTERACTIVE_ANNOTATION_SUBTYPES.has(subtype.decodeText())
      ) {
        return true;
      }
      if (annot.get(PDFName.of("AA"))) return true;
      const rawAction = annot.get(PDFName.of("A"));
      if (!rawAction) continue;
      // Only Link annotations have action semantics that this feature
      // intentionally preserves and remaps.
      if (!(subtype instanceof PDFName) || subtype.decodeText() !== "Link") {
        return true;
      }
      const action = lookupDict(document, rawAction);
      if (!action || action.get(PDFName.of("Next"))) return true;
      const actionType = resolveObject(document, action.get(PDFName.of("S")));
      if (!(actionType instanceof PDFName)) return true;
      const type = actionType.decodeText();
      if (type !== "GoTo" && type !== "URI") return true;
      if (type === "URI") {
        const uri = resolveObject(document, action.get(PDFName.of("URI")));
        if (
          !(uri instanceof PDFString || uri instanceof PDFHexString) ||
          !SAFE_URI_SCHEME.test(uri.decodeText().trim())
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * An /AcroForm with no fields, no XFA and no signature flags holds nothing a
 * copied page could depend on (flattened forms and some generators leave one
 * behind). Widgets on the pages are still caught by the annotation check.
 */
function hasFormStructures(document: PDFDocument): boolean {
  const raw = document.catalog.get(PDFName.of("AcroForm"));
  if (!raw) return false;
  const form = lookupDict(document, raw);
  if (!form) return true;
  if (form.get(PDFName.of("XFA")) || form.get(PDFName.of("SigFlags"))) {
    return true;
  }
  const fields = lookupArray(document, form.get(PDFName.of("Fields")));
  return !fields || fields.size() > 0;
}
