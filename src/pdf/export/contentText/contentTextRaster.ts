import { PDFDocument, PDFName, PDFObjectCopier, PDFPage } from 'pdf-lib';
import type { PdfRect } from '../../model/types';
import { intersectRect } from './regionProof/geometry';

export type RasterRegion = { x: number; y: number; width: number; height: number };
export type Raster = { width: number; height: number; data: Uint8ClampedArray };
export type ContactRenderer = (bytes: Uint8Array, index: number, region: RasterRegion, scale: number) => Promise<Raster>;

export function contentTextRasterRegion(frame: PdfRect, box: PdfRect, scale: number) {
  const clipped = intersectRect(frame, box);
  if (!clipped) return;
  const x = Math.floor((clipped.x - frame.x) * scale);
  const y = Math.floor((frame.y + frame.h - clipped.y - clipped.h) * scale);
  const width = Math.ceil((clipped.x + clipped.w - frame.x) * scale) - x;
  const height = Math.ceil((frame.y + frame.h - clipped.y) * scale) - y;
  if (width * height <= 1_000_000) return { x, y, width, height };
}

export const colorDelta = (a: Uint8ClampedArray, b: Uint8ClampedArray, i: number, j = i) =>
  Math.max(Math.abs(a[i]! - b[j]!), Math.abs(a[i + 1]! - b[j + 1]!), Math.abs(a[i + 2]! - b[j + 2]!));

export function matchesRasterRegion(raster: Raster, region: RasterRegion) {
  return raster.width === region.width && raster.height === region.height && raster.data.length === region.width * region.height * 4;
}

/** The probe has its own page and streams. Shared source objects are copied
 * only after the detached page has been prepared. */
export async function saveRasterProbe(page: PDFPage, bytes?: Uint8Array) {
  const output = await PDFDocument.create();
  const copier = PDFObjectCopier.for(page.doc.context, output.context);
  const node = copier.copy(page.node);
  node.delete(PDFName.of('Annots'));
  const copy = PDFPage.of(node, output.context.register(node), output);
  output.addPage(copy);
  if (bytes) copy.node.set(PDFName.of('Contents'), output.context.register(output.context.flateStream(bytes)));
  return output.save();
}
