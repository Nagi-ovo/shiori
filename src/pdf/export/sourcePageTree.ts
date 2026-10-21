import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFPageLeaf,
  PDFPageTree,
  PDFRef,
  type PDFDocument,
  type PDFObject,
} from "pdf-lib";

/**
 * Make pdf-lib read a source's page tree the way PDFium numbers it, so that
 * getPages()[sourceIndex] is the page the user saw at that index.
 *
 * PDFium takes a /Kids entry with /Kids of its own for a node and any other
 * dictionary for a page, whatever its /Type says (see
 * src/pdf/import/sourcePages.ts, the import side of the same rule). pdf-lib
 * fixes each object's class when it parses /Type, and getPages() keeps only
 * /Type /Page leaves under /Type /Pages nodes: one untyped page shifted every
 * later page of an export by one, and the last could not be copied at all.
 * Each such dictionary is replaced in place by the class PDFium reads it as,
 * with /Type set so the copy written to the export is a real page.
 *
 * Must run before the first getPages() on `pdf`, which caches its result.
 * Still apart from PDFium: a /Kids entry that is not a dictionary takes a
 * page number there and none here, and a cyclic tree.
 */
export function alignPageTreeWithPdfium(pdf: PDFDocument): void {
  const rootEntry = pdf.catalog.get(PDFName.of("Pages"));
  const root = pdf.context.lookup(rootEntry);
  if (!(root instanceof PDFDict) || !root.has(PDFName.of("Kids"))) return;
  const seen = new Set<PDFDict>();
  const stack: PDFDict[] = [place(pdf, rootEntry, root, seen)];
  while (stack.length > 0) {
    const kids = stack.pop()!.lookup(PDFName.of("Kids"));
    if (!(kids instanceof PDFArray)) continue;
    for (let i = 0; i < kids.size(); i += 1) {
      const entry = kids.get(i);
      const kid = pdf.context.lookup(entry);
      if (!(kid instanceof PDFDict) || seen.has(kid)) continue;
      const node = place(pdf, entry, kid, seen, (typed) => kids.set(i, typed));
      if (node instanceof PDFPageTree) stack.push(node);
    }
  }
}

/** `dict` as PDFium reads it, put where `entry` points. */
function place(
  pdf: PDFDocument,
  entry: PDFObject | undefined,
  dict: PDFDict,
  seen: Set<PDFDict>,
  setDirect?: (typed: PDFDict) => void,
): PDFDict {
  seen.add(dict);
  const isNode = dict.has(PDFName.of("Kids"));
  if (isNode ? dict instanceof PDFPageTree : dict instanceof PDFPageLeaf) {
    return dict;
  }
  const map = new Map(dict.entries());
  map.set(PDFName.of("Type"), PDFName.of(isNode ? "Pages" : "Page"));
  const typed = isNode
    ? PDFPageTree.fromMapWithContext(map, pdf.context)
    : PDFPageLeaf.fromMapWithContext(map, pdf.context);
  if (entry instanceof PDFRef) pdf.context.assign(entry, typed);
  else if (setDirect) setDirect(typed);
  else pdf.catalog.set(PDFName.of("Pages"), typed);
  seen.add(typed);
  return typed;
}
