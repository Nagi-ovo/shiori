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
import { MAX_PDF_PAGES, PdfOpenError, assertPdfWithinPageLimit } from "../openPolicy";

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
 * Throws the open policy's tooManyPages error rather than let getPages() walk
 * a tree that lists more pages than Shiori opens, or a cyclic one.
 * Still apart from PDFium: a /Kids entry that is not a dictionary takes a
 * page number there and none here.
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
  assertBoundedPageWalk(pdf);
}

/**
 * pdf-lib's getPages() walks a subtree once for every /Kids entry naming it:
 * one shared subtree nested k deep lists 2^k pages, and a cycle never ends.
 * PDFium trusts the root's /Count and stops there, so such a file opens. Count
 * the walk without taking it, each node once, and refuse past the page limit.
 */
function assertBoundedPageWalk(pdf: PDFDocument): void {
  const root = pdf.catalog.lookup(PDFName.of("Pages"));
  if (!(root instanceof PDFPageTree)) return;
  const counted = new Map<PDFDict, number>();
  const open = new Set<PDFDict>();
  const listed = (node: PDFPageTree): number => {
    const known = counted.get(node);
    if (known !== undefined) return known;
    if (open.has(node)) {
      throw new PdfOpenError("tooManyPages", "PDF page tree is cyclic");
    }
    open.add(node);
    let total = 0;
    const kids = node.lookup(PDFName.of("Kids"));
    if (kids instanceof PDFArray) {
      for (let i = 0; i < kids.size() && total <= MAX_PDF_PAGES; i += 1) {
        const kid = pdf.context.lookup(kids.get(i));
        if (kid instanceof PDFPageTree) total += listed(kid);
        else if (kid instanceof PDFPageLeaf) total += 1;
      }
    }
    open.delete(node);
    counted.set(node, total);
    return total;
  };
  assertPdfWithinPageLimit(listed(root));
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
