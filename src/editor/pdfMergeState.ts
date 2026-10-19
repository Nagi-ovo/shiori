import {
  MAX_PDF_BYTES,
  PdfOpenError,
} from "../pdf/openPolicy";
import type { PageModel, Rotation } from "../pdf/model/types";

export type PdfPhysicalPageGeometry = {
  rotation: Rotation;
  originXPt: number;
  originYPt: number;
  widthPt: number;
  heightPt: number;
};

export type PhysicalAppendInsertionPlan = {
  /** Every physical page in the replacement PDF, in byte-stream order. */
  sourcePages: PageModel[];
  /** Existing logical pages with the appended physical pages spliced into the UI. */
  pages: PageModel[];
  insertedPages: PageModel[];
  /** Base pages whose native annotations must stay suppressed for Undo. */
  baseSourceIndices: number[];
};

/**
 * Reject a merge before either input is copied or parsed.
 *
 * Checking each PDF independently allows two 200 MiB inputs into a pipeline
 * that necessarily holds several whole-file copies. The subtraction form also
 * avoids overflowing a future non-Uint8Array caller's numeric sum.
 */
export function assertPdfMergeInputWithinFileLimit(
  baseBytes: number,
  incomingBytes: number,
  maxBytes: number = MAX_PDF_BYTES,
): void {
  if (
    !Number.isSafeInteger(baseBytes) ||
    !Number.isSafeInteger(incomingBytes) ||
    !Number.isSafeInteger(maxBytes) ||
    baseBytes < 0 ||
    incomingBytes < 0 ||
    maxBytes < 0 ||
    baseBytes > maxBytes - incomingBytes
  ) {
    throw new PdfOpenError(
      "tooLarge",
      `Combined PDF inputs are ${baseBytes} + ${incomingBytes} bytes`,
    );
  }
}

/**
 * Plan a logical insertion when incoming PDF pages were physically appended.
 *
 * Existing source indices must not move: every Undo snapshot uses them to read
 * the original page bytes. Appending to the physical PDF preserves that
 * identity, while this pure model splice puts the new pages where the reader
 * requested them. Deleted/reordered/blank pages stay exactly as they were.
 */
export function planPhysicalAppendInsertion({
  previousPages,
  outputGeometry,
  basePhysicalPageCount,
  insertionIndex,
  insertedPageCount,
  createId,
}: {
  previousPages: readonly PageModel[];
  outputGeometry: readonly PdfPhysicalPageGeometry[];
  basePhysicalPageCount: number;
  insertionIndex: number;
  insertedPageCount: number;
  createId: () => string;
}): PhysicalAppendInsertionPlan {
  if (
    !Number.isInteger(basePhysicalPageCount) ||
    basePhysicalPageCount < 0
  ) {
    throw new Error(`invalid-base-page-count:${basePhysicalPageCount}`);
  }
  if (
    !Number.isInteger(insertionIndex) ||
    insertionIndex < 0 ||
    insertionIndex > previousPages.length
  ) {
    throw new Error(`invalid-insertion-index:${insertionIndex}`);
  }
  if (!Number.isInteger(insertedPageCount) || insertedPageCount <= 0) {
    throw new Error(`invalid-inserted-page-count:${insertedPageCount}`);
  }
  if (outputGeometry.length !== basePhysicalPageCount + insertedPageCount) {
    throw new Error(
      `page-layout-mismatch:${outputGeometry.length}:` +
        `${basePhysicalPageCount + insertedPageCount}`,
    );
  }
  for (const page of previousPages) {
    if (page.sourceIndex >= basePhysicalPageCount) {
      throw new Error(
        `existing-source-index-out-of-range:${page.sourceIndex}:` +
          `${basePhysicalPageCount}`,
      );
    }
  }

  // IDs on sourcePages are not editor history, but reusing a visible page's ID
  // keeps the as-opened baseline legible in diagnostics. A deleted source page
  // has no current logical owner, so it receives a fresh baseline-only ID.
  const visiblePageBySourceIndex = new Map<number, PageModel>();
  for (const page of previousPages) {
    if (page.sourceIndex >= 0 && !visiblePageBySourceIndex.has(page.sourceIndex)) {
      visiblePageBySourceIndex.set(page.sourceIndex, page);
    }
  }

  const sourcePages = outputGeometry.map((geometry, sourceIndex): PageModel => ({
    id:
      visiblePageBySourceIndex.get(sourceIndex)?.id ??
      createId(),
    sourceIndex,
    ...geometry,
  }));
  const insertedPages = sourcePages.slice(basePhysicalPageCount);
  const pages = [
    ...previousPages.slice(0, insertionIndex),
    ...insertedPages,
    ...previousPages.slice(insertionIndex),
  ];
  const baseSourceIndices = Array.from(
    { length: basePhysicalPageCount },
    (_, index) => index,
  );
  return { sourcePages, pages, insertedPages, baseSourceIndices };
}
