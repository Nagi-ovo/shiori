import type { Overlay, PageModel, PdfPoint, PdfRect } from "./types";

export function pageOrigin(page: PageModel): PdfPoint {
  return {
    x: finiteOrZero(page.originXPt),
    y: finiteOrZero(page.originYPt),
  };
}

export function hasPageOrigin(page: PageModel): boolean {
  const origin = pageOrigin(page);
  return origin.x !== 0 || origin.y !== 0;
}

export function pdfPointToPageLocal(page: PageModel, point: PdfPoint): PdfPoint {
  const origin = pageOrigin(page);
  return { x: point.x - origin.x, y: point.y - origin.y };
}

export function pdfRectToPageLocal(page: PageModel, rect: PdfRect): PdfRect {
  const origin = pageOrigin(page);
  return { ...rect, x: rect.x - origin.x, y: rect.y - origin.y };
}

export function overlayToPdfPageSpace(page: PageModel, overlay: Overlay): Overlay {
  const origin = pageOrigin(page);
  if (origin.x === 0 && origin.y === 0) return overlay;
  return translateOverlay(overlay, origin.x, origin.y);
}

function translateOverlay(overlay: Overlay, dx: number, dy: number): Overlay {
  if (
    overlay.type === "highlight" ||
    overlay.type === "underline" ||
    overlay.type === "strikethrough"
  ) {
    return {
      ...overlay,
      rects: overlay.rects.map((rect) => translateRect(rect, dx, dy)),
    };
  }
  if (overlay.type === "ink") {
    return {
      ...overlay,
      paths: overlay.paths.map((path) =>
        path.map((point) => ({ x: point.x + dx, y: point.y + dy })),
      ),
    };
  }
  if (overlay.type === "contentText") {
    return {
      ...overlay,
      rect: translateRect(overlay.rect, dx, dy),
      coverRects: overlay.coverRects.map((rect) => translateRect(rect, dx, dy)),
      sourceBaselinesPt: overlay.sourceBaselinesPt?.map((y) => y + dy),
    };
  }
  if (overlay.type === "callout") {
    return {
      ...overlay,
      rect: translateRect(overlay.rect, dx, dy),
      targetRects: overlay.targetRects.map((rect) =>
        translateRect(rect, dx, dy),
      ),
      leader: overlay.leader?.map((point) => ({
        x: point.x + dx,
        y: point.y + dy,
      })),
    };
  }
  return {
    ...overlay,
    rect: translateRect(overlay.rect, dx, dy),
  };
}

function translateRect(rect: PdfRect, dx: number, dy: number): PdfRect {
  return { ...rect, x: rect.x + dx, y: rect.y + dy };
}

function finiteOrZero(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
