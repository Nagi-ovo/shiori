import type { DocumentModel, PageModel } from "./types";
import { isBlankPage } from "./types";
import { pageOrigin } from "./pageSpace";

export function isModelClean(
  model: DocumentModel,
  sourcePages: PageModel[],
): boolean {
  if (model.overlays.length > 0) return false;
  if (model.pages.length !== sourcePages.length) return false;
  return model.pages.every((page, index) => {
    const source = sourcePages[index];
    if (!source) return false;
    if (isBlankPage(page)) return false;
    return (
      page.sourceIndex === index &&
      page.rotation === source.rotation &&
      nearlyEqual(pageOrigin(page).x, pageOrigin(source).x) &&
      nearlyEqual(pageOrigin(page).y, pageOrigin(source).y) &&
      nearlyEqual(page.widthPt, source.widthPt) &&
      nearlyEqual(page.heightPt, source.heightPt)
    );
  });
}

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.01;
}
