import type { PageModel, Rotation } from "../model/types";

export type PdfPageGeometry = {
  rotation: Rotation;
  originXPt: number;
  originYPt: number;
  widthPt: number;
  heightPt: number;
};

export type ReconciledPdfInsertion = {
  pages: PageModel[];
  basePages: PageModel[];
  insertedPages: PageModel[];
  baseOutputSourceIndices: number[];
};

/**
 * Reattach stable editor page IDs to a newly serialized PDF after a contiguous
 * insertion. The PDF's source indices have changed; page IDs and overlay
 * ownership must not. Kept pure so reorder/duplicate/blank-page edge cases can
 * be verified without opening a PDF.
 */
export function reconcilePdfPageInsertion({
  previousPages,
  outputGeometry,
  insertionIndex,
  insertedPageCount,
  createId,
}: {
  previousPages: readonly PageModel[];
  outputGeometry: readonly PdfPageGeometry[];
  insertionIndex: number;
  insertedPageCount: number;
  createId: () => string;
}): ReconciledPdfInsertion {
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
  if (outputGeometry.length !== previousPages.length + insertedPageCount) {
    throw new Error(
      `page-layout-mismatch:${outputGeometry.length}:` +
        `${previousPages.length + insertedPageCount}`,
    );
  }

  const pages: PageModel[] = [];
  const basePages: PageModel[] = [];
  const insertedPages: PageModel[] = [];
  const baseOutputSourceIndices: number[] = [];
  for (let outputIndex = 0; outputIndex < outputGeometry.length; outputIndex += 1) {
    const geometry = outputGeometry[outputIndex]!;
    const isInserted =
      outputIndex >= insertionIndex &&
      outputIndex < insertionIndex + insertedPageCount;
    const previousIndex =
      outputIndex < insertionIndex
        ? outputIndex
        : outputIndex - insertedPageCount;
    const previous = isInserted ? undefined : previousPages[previousIndex];
    if (!isInserted && !previous) {
      throw new Error(`missing-previous-page:${previousIndex}`);
    }
    const page: PageModel = {
      id: previous?.id ?? createId(),
      sourceIndex: outputIndex,
      ...geometry,
    };
    pages.push(page);
    if (isInserted) insertedPages.push(page);
    else {
      basePages.push(page);
      baseOutputSourceIndices.push(outputIndex);
    }
  }
  return { pages, basePages, insertedPages, baseOutputSourceIndices };
}
