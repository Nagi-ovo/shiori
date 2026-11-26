import { displayToPdf, pdfToDisplay } from "../../pdf/geometry/coords";
import type { SourceImageInfo } from "../../pdf/export/sourceImages";
import { sourceImageClips } from "../../pdf/export/sourceImages/clips";
import { projectImagePoint as mapPoint } from "../../pdf/export/sourceImages/clipShape";
import { clipOutline, identity, outlineArea } from "../../pdf/export/sourceImages/outline";
import type { SourceImageMatrix } from "../../pdf/export/sourceImages/content";
import { centeredRotation, imageCropOperands, imageTransformChange, inverse, placedImageMatrix } from "../../pdf/export/sourceImages/placement";
import type { PageModel, PdfPoint, PdfRect, SourceImageEditOverlay } from "../../pdf/model/types";
import { findSourceImageEdit, fullImage, type SourceImagePatch } from "../store/sourceImageEdits";

export type ImageHandle = "move" | "resize" | "rotate" | "crop" | "cropStart";

export { mapPoint };

export function imageRectCorners({ x, y, w, h }: PdfRect): PdfPoint[] {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

export function imageMatrix(image: SourceImageInfo, edit?: Pick<SourceImageEditOverlay, "rect" | "angle">) {
  const { bbox } = image;
  const [a, b, c, d] = image.matrix;
  // The minimum transformed corner is the locator's page-local bbox origin.
  // Deriving the translation from it uses the exact visible box of the writer.
  const matrix: SourceImageMatrix = [a, b, c, d,
    bbox.x - Math.min(0, a) - Math.min(0, c), bbox.y - Math.min(0, b) - Math.min(0, d)];
  return placedImageMatrix(matrix, bbox, edit?.rect, edit?.angle ?? 0);
}

export function imageResizePoint(
  image: SourceImageInfo, edit?: Pick<SourceImageEditOverlay, "rect" | "angle" | "crop">,
): PdfPoint {
  const { x, y, w, h } = edit?.crop ?? fullImage;
  return mapPoint(imageMatrix(image, edit), { x: x + w, y: y + h });
}

export function imageDisplayPoint(point: PdfPoint, page: PageModel, scale: number) {
  return pdfToDisplay(point, page.widthPt, page.heightPt, page.rotation, scale);
}

export function imagePagePoint(point: PdfPoint, page: PageModel, scale: number) {
  return displayToPdf(point, page.widthPt, page.heightPt, page.rotation, scale);
}

const center = (r: PdfRect): PdfPoint => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
export function imageVisibleOutline(
  image: SourceImageInfo, edit: SourceImagePatch | undefined, page: PageModel,
): PdfPoint[] {
  if (edit?.delete || !(image.bbox.w > 0 && image.bbox.h > 0)) return [];
  try {
    const original = imageMatrix(image);
    const desired = imageMatrix(image, edit);
    const moved = desired.some((value, i) => value !== original[i]);
    const matrix = moved ? imageTransformChange(original, desired).written : original;
    const [x, y, w, h] = imageCropOperands(edit?.crop ?? fullImage).map(Number);
    if (!(w! > 0 && h! > 0)) return [];
    let outline = imageRectCorners({ x: x!, y: y!, w: w!, h: h! }).map(point => mapPoint(matrix, point));
    // A rendered geometry edit has already passed the writer's visibility
    // check for each source clip or escaped it in the rewritten stream.
    if (!moved) {
      for (const clip of sourceImageClips(image)) {
        outline = clipOutline(outline, clip);
        if (outline.length < 3) return [];
      }
    }
    outline = clipOutline(outline, { matrix: identity, box: { x: 0, y: 0, w: page.widthPt, h: page.heightPt } });
    return outlineArea(outline) ? outline : [];
  } catch {
    return [];
  }
}

export function imageVisibleCrop(image: SourceImageInfo, edit: SourceImagePatch | undefined, outline: PdfPoint[]): PdfRect {
  const crop = edit?.crop ?? fullImage;
  const toImage = inverse(imageMatrix(image, edit));
  const points = outline.map(point => mapPoint(toImage, point));
  const left = Math.max(crop.x, Math.min(...points.map(p => p.x)));
  const bottom = Math.max(crop.y, Math.min(...points.map(p => p.y)));
  const right = Math.min(crop.x + crop.w, Math.max(...points.map(p => p.x)));
  const top = Math.min(crop.y + crop.h, Math.max(...points.map(p => p.y)));
  return right > left && top > bottom ? { x: left, y: bottom, w: right - left, h: top - bottom } : crop;
}

function inOutline(outline: PdfPoint[], point: PdfPoint) {
  let left = false, right = false;
  for (const [i, a] of outline.entries()) {
    const b = outline[(i + 1) % outline.length]!;
    const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
    left ||= cross > 1e-8;
    right ||= cross < -1e-8;
    if (left && right) return false;
  }
  return left || right;
}

export function hitSourceImage(
  images: readonly SourceImageInfo[], edits: readonly SourceImageEditOverlay[],
  page: PageModel, scale: number, display: PdfPoint,
): SourceImageInfo | undefined {
  const point = imagePagePoint(display, page, scale);
  return images.findLast(image => image.pageIndex === page.sourceIndex &&
    inOutline(imageVisibleOutline(image, findSourceImageEdit(edits, page.id, image), page), point));
}

const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(n, high));

/** Compute from the gesture's initial state so neither rounding nor zoom accumulates. */
export function imageGesturePatch(
  image: SourceImageInfo, edit: SourceImageEditOverlay | undefined,
  handle: ImageHandle, start: PdfPoint, point: PdfPoint, snap = false, visibleCrop?: PdfRect,
): SourceImagePatch {
  const rect = edit?.rect ?? image.bbox;
  const angle = edit?.angle ?? 0;
  const delta = { x: point.x - start.x, y: point.y - start.y };
  if (!delta.x && !delta.y) return {};
  if (handle === "move") return { rect: { ...rect, x: rect.x + delta.x, y: rect.y + delta.y } };
  if (handle === "rotate") {
    const pivot = center(rect);
    const direction = (p: PdfPoint) => Math.atan2(p.y - pivot.y, p.x - pivot.x);
    const next = angle + (direction(start) - direction(point)) * 180 / Math.PI;
    return { angle: snap ? Math.round(next / 15) * 15 : next };
  }
  if (handle === "resize") {
    const local = mapPoint(centeredRotation(-angle, { x: 0, y: 0, w: 0, h: 0 }), delta);
    const crop = edit?.crop ?? fullImage;
    const dw = local.x / crop.w;
    const dh = local.y / crop.h;
    const w = rect.w + dw;
    const h = rect.h + dh;
    // Resize about the opposite visible corner in the rectangular placement.
    const shift = mapPoint(centeredRotation(angle, { x: 0, y: 0, w: 0, h: 0 }), {
      x: dw * (.5 - crop.x), y: dh * (.5 - crop.y),
    });
    const pivot = center(rect);
    const next = { x: pivot.x + shift.x - w / 2, y: pivot.y + shift.y - h / 2, w, h };
    try {
      const [, , , , x, y] = imageMatrix(image);
      const desired = placedImageMatrix(image.matrix, image.bbox, {
        ...next, x: next.x + (image.matrix[4] - x), y: next.y + (image.matrix[5] - y),
      }, angle);
      imageTransformChange(image.matrix, desired);
      return { rect: next };
    } catch {
      return {};
    }
  }
  const crop = visibleCrop ?? edit?.crop ?? fullImage;
  const transform = inverse(imageMatrix(image, edit));
  const before = mapPoint(transform, start);
  const after = mapPoint(transform, point);
  const right = crop.x + crop.w;
  const top = crop.y + crop.h;
  const minW = Math.min(.001, crop.w);
  const minH = Math.min(.001, crop.h);
  if (handle === "cropStart") {
    const x = clamp(crop.x + after.x - before.x, 0, right - minW);
    const y = clamp(crop.y + after.y - before.y, 0, top - minH);
    return { crop: { x, y, w: right - x, h: top - y } };
  }
  const x = clamp(right + after.x - before.x, crop.x + minW, 1);
  const y = clamp(top + after.y - before.y, crop.y + minH, 1);
  return { crop: { ...crop, w: Math.min(x - crop.x, 1 - crop.x), h: Math.min(y - crop.y, 1 - crop.y) } };
}
