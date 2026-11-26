import type { PDFPage } from 'pdf-lib';
import { hasPageOrigin, overlayToPdfPageSpace, pageOrigin } from '../model/pageSpace';
import { isBlankPage, type Overlay, type PageModel } from '../model/types';

export function overlaysForPdfPage(page: PageModel, overlays: Overlay[]): Overlay[] {
  const pageOverlays = overlays.filter((overlay) => overlay.pageId === page.id);
  if (!hasPageOrigin(page)) return pageOverlays;
  return pageOverlays.map((overlay) => overlayToPdfPageSpace(page, overlay));
}

export function pagesMatchSource(modelPages: PageModel[], sourcePages: PDFPage[]): boolean {
  if (modelPages.length !== sourcePages.length) return false;
  return modelPages.every((page, index) => {
    if (isBlankPage(page)) return false;
    if (page.sourceIndex !== index) return false;
    const sourcePage = sourcePages[index]!;
    const sourceBox = sourcePage.getCropBox();
    const origin = pageOrigin(page);
    return (
      page.rotation === normalizeRotation(sourcePage.getRotation().angle) &&
      nearlyEqual(page.widthPt, sourceBox.width) &&
      nearlyEqual(page.heightPt, sourceBox.height) &&
      nearlyEqual(origin.x, sourceBox.x) &&
      nearlyEqual(origin.y, sourceBox.y)
    );
  });
}

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.01;
}

function normalizeRotation(angle: number): PageModel["rotation"] {
  return ((((angle % 360) + 360) % 360) as PageModel["rotation"]);
}
