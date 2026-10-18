import type { PdfPoint, PdfRect, Rotation } from "../model/types";

// In PDF user space, the origin is bottom-left. In DOM, origin is top-left.
// We store all overlay coordinates in PDF user space (points) of the ORIGINAL
// (unrotated) page. For display, we apply rotation on top of page width/height.

export type RotatedSize = { width: number; height: number };

export function rotatedSize(
  widthPt: number,
  heightPt: number,
  rotation: Rotation,
): RotatedSize {
  if (rotation === 90 || rotation === 270) {
    return { width: heightPt, height: widthPt };
  }
  return { width: widthPt, height: heightPt };
}

// Convert a PDF-space point on the unrotated page to a display-space point
// (origin top-left) on the rotated page at given scale.
export function pdfToDisplay(
  p: PdfPoint,
  widthPt: number,
  heightPt: number,
  rotation: Rotation,
  scale: number,
): { x: number; y: number } {
  let rx = p.x;
  let ry = p.y;
  switch (rotation) {
    case 0:
      rx = p.x;
      ry = heightPt - p.y;
      break;
    case 90:
      rx = p.y;
      ry = p.x;
      break;
    case 180:
      rx = widthPt - p.x;
      ry = p.y;
      break;
    case 270:
      rx = heightPt - p.y;
      ry = widthPt - p.x;
      break;
  }
  return { x: rx * scale, y: ry * scale };
}

// Convert a display-space point (origin top-left, rotated page) to a PDF-space
// point on the unrotated page.
export function displayToPdf(
  d: { x: number; y: number },
  widthPt: number,
  heightPt: number,
  rotation: Rotation,
  scale: number,
): PdfPoint {
  const dx = d.x / scale;
  const dy = d.y / scale;
  switch (rotation) {
    case 0:
      return { x: dx, y: heightPt - dy };
    case 90:
      return { x: dy, y: dx };
    case 180:
      return { x: widthPt - dx, y: dy };
    case 270:
      return { x: widthPt - dy, y: heightPt - dx };
  }
}

// Convert a PDF rect (origin bottom-left) into a display rect (origin top-left)
// for the rotated page at scale.
export function pdfRectToDisplay(
  r: PdfRect,
  widthPt: number,
  heightPt: number,
  rotation: Rotation,
  scale: number,
): { x: number; y: number; w: number; h: number } {
  const a = pdfToDisplay({ x: r.x, y: r.y }, widthPt, heightPt, rotation, scale);
  const b = pdfToDisplay(
    { x: r.x + r.w, y: r.y + r.h },
    widthPt,
    heightPt,
    rotation,
    scale,
  );
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(a.x - b.x);
  const h = Math.abs(a.y - b.y);
  return { x, y, w, h };
}

export function displayRectToPdf(
  r: { x: number; y: number; w: number; h: number },
  widthPt: number,
  heightPt: number,
  rotation: Rotation,
  scale: number,
): PdfRect {
  const a = displayToPdf({ x: r.x, y: r.y }, widthPt, heightPt, rotation, scale);
  const b = displayToPdf(
    { x: r.x + r.w, y: r.y + r.h },
    widthPt,
    heightPt,
    rotation,
    scale,
  );
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(a.x - b.x);
  const h = Math.abs(a.y - b.y);
  return { x, y, w, h };
}
