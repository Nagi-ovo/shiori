import type { PdfPoint, PdfRect, SourceImageEditOverlay } from "../../model/types";
import type { SourceImageLocation } from "../sourceImages";
import { formPageBox } from "../contentText/retypesetForms";
import { pdfNumber } from "../contentStreamEdit/runEncoding";
import type { SourceImageMatrix, SourceImageOperation } from "./content";
import { clipRemovals } from "./clips";
import { compose } from "./graphics";
import { clipEdgeDistances, projectImagePoint, shapeCorners, type ImageClip } from "./clipShape";
import { clipOutline, identity, inverse, outlineArea } from "./outline";

export { inverse };

const unit: PdfRect = { x: 0, y: 0, w: 1, h: 1 };
const tolerance = 1e-6;

export function centeredRotation(angle: number, box: PdfRect): SourceImageMatrix {
  const rad = -(angle % 360) * Math.PI / 180;
  const x = box.x + box.w / 2;
  const y = box.y + box.h / 2;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [cos, sin, -sin, cos, x - cos * x + sin * y, y - sin * x - cos * y];
}

function finiteImageRect({ x, y, w, h }: PdfRect): boolean {
  const right = x + w;
  const top = y + h;
  return right > x && top > y && [x, y, right, top].every(Number.isFinite);
}

function containsCrop(clip: ImageClip, placement: SourceImageMatrix, crop: PdfRect): boolean {
  const [a, b, c, d] = clip.matrix;
  const determinant = a * d - b * c;
  const orientation = Math.sign(determinant);
  const path = shapeCorners(clip).map(point => projectImagePoint(clip.matrix, point));
  if (!Number.isFinite(determinant) || !orientation || !path.length) return false;
  const painted = corners(crop).map(point => projectImagePoint(placement, point));
  return clipEdgeDistances(path, orientation).every(distance => painted.every(point => distance(point) >= -tolerance));
}

export function boundsUnion(a: PdfRect, b: PdfRect): PdfRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

function corners({ x, y, w, h }: PdfRect): PdfPoint[] {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

export function clipInForm(from: SourceImageMatrix, to: SourceImageMatrix, box: PdfRect): string {
  const [a, b, c, d, e, f] = compose(inverse(to), from);
  return corners(box).map(({ x, y }, i) =>
    `${pdfNumber(a * x + c * y + e)} ${pdfNumber(b * x + d * y + f)} ${i === 0 ? "m" : "l"}`,
  ).join("\n") + "\nh W n\n";
}

/** An explicit rect maps the unit square directly. Otherwise retain the source CTM. */
export function placedImageMatrix(
  matrix: SourceImageMatrix, box: PdfRect, rect: PdfRect | undefined, angle: number,
): SourceImageMatrix {
  if (!Number.isFinite(angle) || (rect && !finiteImageRect(rect))) throw Error("invalid image placement");
  const placement: SourceImageMatrix = rect ? [rect.w, 0, 0, rect.h, rect.x, rect.y] : matrix;
  return angle % 360 ? compose(centeredRotation(angle, rect ?? box), placement) : placement;
}

export function imageTransformChange(matrix: SourceImageMatrix, desired: SourceImageMatrix) {
  const delta = compose(inverse(matrix), desired).map(pdfNumber);
  const written = compose(matrix, delta.map(Number) as SourceImageMatrix);
  // Validate the serialized transform before changing the paint or previewing a drag.
  const [a, b, c, d] = written;
  const [da, db, dc, dd] = desired;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || det === 0 || Math.sign(det) !== Math.sign(da * dd - db * dc) ||
      written.some((n, i) => Math.abs(n - desired[i]!) > 0.01) || !finiteImageRect(formPageBox(written, unit))) {
    throw Error("image placement exceeds PDF transform precision");
  }
  return { delta, written };
}

export function imageCropOperands({ x, y, w, h }: PdfRect) {
  return [x, y, w, h].map(pdfNumber);
}

function visibleBox(outline: PdfPoint[]): PdfRect[] {
  if (!outlineArea(outline)) return [];
  const x = Math.min(...outline.map(p => p.x));
  const y = Math.min(...outline.map(p => p.y));
  return [{ x, y, w: Math.max(...outline.map(p => p.x)) - x, h: Math.max(...outline.map(p => p.y)) - y }];
}

function cropCoversOutline(crop: PdfPoint[], outline: PdfPoint[], [a, b, c, d]: SourceImageMatrix): boolean {
  // Projection and clipping can round a point just outside a coincident edge.
  const roundoff = 8 * Number.EPSILON * Math.max(...crop.map(({ x, y }) => Math.max(Math.abs(x), Math.abs(y))));
  return clipEdgeDistances(crop, Math.sign(a * d - b * c)).every(distance =>
    outline.every(point => distance(point) >= -roundoff));
}

export function imageAffectedBoxes(location: SourceImageLocation, pageBox: PdfRect, edited: { matrix: SourceImageMatrix; crop: PdfRect }) {
  const { matrix, crop } = edited;
  const original = location.info.matrix;
  const pageClip = { matrix: identity, box: pageBox };
  let source = corners(unit).map(p => projectImagePoint(original, p));
  for (const form of location.forms) source = clipOutline(source, { matrix: form.formToPage, box: form.bbox });
  for (let clip = location.clips.pathClips; clip; clip = clip.parent) source = clipOutline(source, clip);
  source = clipOutline(source, pageClip);

  const destination = corners(crop).map(p => projectImagePoint(matrix, p));
  // At the same transform the original clips still apply. The written crop
  // preserves visible paint if it covers the entire original outline.
  if (matrix.every((value, i) => value === original[i]) && cropCoversOutline(destination, source, matrix)) return [];

  // The placement proof checked retained clips and isolated any clips that
  // the transformed placement escapes.
  return [...visibleBox(source), ...visibleBox(clipOutline(destination, pageClip))];
}

export function imagePlacement(edit: SourceImageEditOverlay, location: SourceImageLocation, pageBox: PdfRect) {
  const requestedCrop = edit.crop ?? unit;
  if (!finiteImageRect(requestedCrop) || requestedCrop.x < 0 || requestedCrop.y < 0 ||
      requestedCrop.x + requestedCrop.w > 1 || requestedCrop.y + requestedCrop.h > 1) {
    throw Error("invalid image crop");
  }
  const coords = imageCropOperands(requestedCrop);
  const [x, y, w, h] = coords.map(Number);
  const crop = { x: x!, y: y!, w: w!, h: h! };
  if (!finiteImageRect(crop)) throw Error("crop exceeds PDF coordinate precision");
  const matrix = location.info.matrix;
  const box = formPageBox(matrix, unit);
  if ((edit.rect || (edit.angle ?? 0) % 360) && !finiteImageRect(box)) throw Error("invalid original image placement");
  const rect = edit.rect && { ...edit.rect, x: edit.rect.x + pageBox.x, y: edit.rect.y + pageBox.y };
  const desired = placedImageMatrix(matrix, box, rect, edit.angle ?? 0);
  const commands: string[] = [];
  let formBounds: PdfRect[] = [];
  let escapeFrom = -1;
  let removals: SourceImageOperation[] = [];
  const transform = desired.some((value, i) => value !== matrix[i]) ? imageTransformChange(matrix, desired) : undefined;
  if (transform) {
    const { delta, written } = transform;
    commands.push(`${delta.join(" ")} cm\n`);
    formBounds = location.forms.map(call => formPageBox(compose(inverse(call.formToPage), written), crop));
    if (formBounds.some(bounds => !finiteImageRect(bounds))) throw Error("unrepresentable Form image bounds");
  }
  // An explicit crop must fit the authored clips even at its original placement.
  if (transform || edit.crop) {
    const sourceContains = (clip: ImageClip) => containsCrop(clip, matrix, crop);
    const destinationContains = (clip: ImageClip) => !transform || containsCrop(clip, transform.written, crop);
    const clips = location.forms.map(form => ({ matrix: form.formToPage, box: form.bbox }));
    if (clips.some(clip => !sourceContains(clip))) {
      throw Error("image placement would reveal samples outside the original Form bounds");
    }
    escapeFrom = clips.findIndex(clip => !destinationContains(clip));
    removals = clipRemovals(location, sourceContains, destinationContains);
  }
  if (crop.x !== 0 || crop.y !== 0 || crop.w !== 1 || crop.h !== 1) {
    commands.push(`${coords.join(" ")} re W n\n`);
  }
  return { commands: commands.join(""), formBounds, escapeFrom, removals,
    ...(commands.length && { placement: { matrix: transform?.written ?? matrix, crop } }),
  };
}
