export type PdfPageBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

// PDF.js falls back to US Letter when MediaBox is missing or invalid. Keeping
// the same fallback is required because its page.view drives anchor geometry.
export const PDFJS_FALLBACK_MEDIA_BOX: PdfPageBox = {
  x: 0,
  y: 0,
  width: 612,
  height: 792,
};

/**
 * Match pdf.js' effective page view: use the positive CropBox/MediaBox
 * intersection, and fall back to MediaBox when the boxes do not intersect.
 * pdf-lib exposes the raw CropBox, so using it directly can shift overlays on
 * malformed-but-readable PDFs whose crop extends outside the media box.
 */
export function effectivePdfPageBox(
  mediaBox: PdfPageBox,
  cropBox: PdfPageBox,
): PdfPageBox {
  const media = normalizeBox(mediaBox) ?? PDFJS_FALLBACK_MEDIA_BOX;
  const crop = normalizeBox(cropBox);
  if (!crop) return media;
  const left = Math.max(media.x, crop.x);
  const bottom = Math.max(media.y, crop.y);
  const right = Math.min(media.x + media.width, crop.x + crop.width);
  const top = Math.min(media.y + media.height, crop.y + crop.height);
  if (right > left && top > bottom) {
    return { x: left, y: bottom, width: right - left, height: top - bottom };
  }
  return media;
}

function normalizeBox(box: PdfPageBox): PdfPageBox | null {
  const values = [box.x, box.y, box.width, box.height];
  if (!values.every(Number.isFinite) || box.width === 0 || box.height === 0) {
    return null;
  }
  const right = box.x + box.width;
  const top = box.y + box.height;
  return {
    x: Math.min(box.x, right),
    y: Math.min(box.y, top),
    width: Math.abs(box.width),
    height: Math.abs(box.height),
  };
}
