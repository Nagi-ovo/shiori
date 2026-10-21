import { PDFDict, PDFDocument, PDFName, PDFObject, PDFStream } from "pdf-lib";
import { isName, lookupArray, lookupDict, resolveObject } from "./pdfObjects";

const STRUCT_PARENT = PDFName.of("StructParent");
const STRUCT_PARENTS = PDFName.of("StructParents");
const APPEARANCE_STATES = ["N", "R", "D"].map((key) => PDFName.of(key));

/**
 * Page insertion copies pages, not the incoming structure tree, so an
 * inserted page's /StructParents (and its annotations' /StructParent) would
 * index into the base document's ParentTree and hand its marked content to
 * unrelated base structure elements. Untagged is honest; aliased is not.
 * Form and image XObjects carry the same keys, so the walk follows the
 * page's resources, nested form, tiling-pattern and Type 3 font resources
 * and annotation appearance streams.
 */
export function dropStructureParents(document: PDFDocument, page: PDFDict) {
  const visited = new Set<PDFObject>();
  page.delete(STRUCT_PARENTS);
  dropFromResources(document, page.get(PDFName.of("Resources")), visited);
  const annots = lookupArray(document, page.get(PDFName.of("Annots")));
  if (!annots) return;
  for (let index = 0; index < annots.size(); index += 1) {
    const annot = lookupDict(document, annots.get(index));
    if (!annot) continue;
    annot.delete(STRUCT_PARENT);
    const appearances = lookupDict(document, annot.get(PDFName.of("AP")));
    for (const state of APPEARANCE_STATES) {
      const entry = resolveObject(document, appearances?.get(state));
      if (entry instanceof PDFStream) {
        dropFromForm(document, entry, visited);
      } else if (entry instanceof PDFDict) {
        for (const [, value] of entry.entries()) {
          const stream = resolveObject(document, value);
          if (stream instanceof PDFStream) dropFromForm(document, stream, visited);
        }
      }
    }
  }
}

function dropFromResources(
  document: PDFDocument,
  raw: PDFObject | undefined,
  visited: Set<PDFObject>,
) {
  const resources = lookupDict(document, raw);
  if (!resources || visited.has(resources)) return;
  visited.add(resources);
  const xobjects = lookupDict(document, resources.get(PDFName.of("XObject")));
  for (const [, value] of xobjects?.entries() ?? []) {
    const stream = resolveObject(document, value);
    if (stream instanceof PDFStream) dropFromForm(document, stream, visited);
  }
  // Tiling patterns and Type 3 fonts carry resources of their own, which can
  // hold tagged images and forms.
  for (const key of ["Pattern", "Font"]) {
    const entries = lookupDict(document, resources.get(PDFName.of(key)));
    for (const [, value] of entries?.entries() ?? []) {
      const owner = resolveObject(document, value);
      const dict = owner instanceof PDFStream ? owner.dict : owner;
      if (dict instanceof PDFDict) {
        dropFromResources(document, dict.get(PDFName.of("Resources")), visited);
      }
    }
  }
}

function dropFromForm(
  document: PDFDocument,
  stream: PDFStream,
  visited: Set<PDFObject>,
) {
  if (visited.has(stream)) return;
  visited.add(stream);
  const subtype = stream.dict.get(PDFName.of("Subtype"));
  if (isName(document, subtype, "Image")) {
    // A tagged image is itself a structural content item (/StructParent).
    stream.dict.delete(STRUCT_PARENT);
    return;
  }
  if (!isName(document, subtype, "Form")) return;
  stream.dict.delete(STRUCT_PARENT);
  stream.dict.delete(STRUCT_PARENTS);
  dropFromResources(document, stream.dict.get(PDFName.of("Resources")), visited);
}
