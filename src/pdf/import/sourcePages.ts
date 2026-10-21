import { PDFArray, PDFDict, PDFName, PDFNumber, type PDFDocument, type PDFObject } from "pdf-lib";

/**
 * The file's page dictionaries in the order PDFium numbers them, which is
 * what every `sourceIndex` counts. pdf-lib's getPages() keeps only leaves
 * typed /Type /Page, while PDFium takes any kid without /Kids for a page, so
 * a page missing its /Type would shift every later page by one. A kid that is
 * not a dictionary still takes its place (null), as in PDFium's traversal. A
 * node listed twice is walked twice, as PDFium and pdf-lib both do; only a
 * node that is its own ancestor is skipped, so a cyclic tree ends, and the
 * walk stops at PDFium's page count so a tree that shares subtrees cannot
 * grow without bound.
 */
export function sourcePageDicts(pdf: PDFDocument): ReadonlyArray<PDFDict | null> {
  let pages = walked.get(pdf);
  if (!pages) {
    pages = walkPageTree(pdf);
    walked.set(pdf, pages);
  }
  return pages;
}

const walked = new WeakMap<PDFDocument, Array<PDFDict | null>>();

/** PDFium's CPDF_Document::kPageMaxNum: a root /Count it trusts is below this. */
const PDFIUM_MAX_PAGES = 0xfffff;

function walkPageTree(pdf: PDFDocument): Array<PDFDict | null> {
  const root = pdf.catalog.lookup(PDFName.of("Pages"));
  if (!(root instanceof PDFDict)) return [];
  const count = root.lookup(PDFName.of("Count"));
  const declared = count instanceof PDFNumber ? count.asNumber() : 0;
  const limit = declared > 0 && declared < PDFIUM_MAX_PAGES ? Math.floor(declared) : PDFIUM_MAX_PAGES;
  const pages: Array<PDFDict | null> = [];
  const ancestors = new Set<PDFDict>([root]);
  const stack: Array<{ node: PDFDict; kids: PDFObject | undefined; next: number }> = [
    { node: root, kids: root.lookup(PDFName.of("Kids")), next: 0 },
  ];
  while (stack.length > 0 && pages.length < limit) {
    const top = stack[stack.length - 1]!;
    if (!(top.kids instanceof PDFArray) || top.next >= top.kids.size()) {
      ancestors.delete(top.node);
      stack.pop();
      continue;
    }
    const kid = top.kids.lookup(top.next++);
    if (!(kid instanceof PDFDict)) pages.push(null);
    // A kid with /Kids is a node, whatever its /Type says; one without is a page.
    else if (!kid.has(PDFName.of("Kids"))) pages.push(kid);
    else if (!ancestors.has(kid)) {
      ancestors.add(kid);
      stack.push({ node: kid, kids: kid.lookup(PDFName.of("Kids")), next: 0 });
    }
  }
  return pages;
}
