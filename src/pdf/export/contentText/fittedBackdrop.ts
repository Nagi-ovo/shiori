import { decodePDFRawStream, PDFDict, PDFName, PDFRawStream, type PDFPage } from 'pdf-lib';
import type { PdfRect } from '../../model/types';
import { tokenizeContentStream, type ContentOp } from '../contentStreamEdit/tokenizer';
import { bounds } from './retypesetInk';
import { colorDelta, contentTextRasterRegion, matchesRasterRegion, saveRasterProbe, type ContactRenderer } from './contentTextRaster';

const rasterScopeOps = new Set(['q', 'Q', 'cm', 're', 'W', 'W*', 'n', 'gs', 'Do']);

/** Follow simple raster-only Forms without treating their BBox or page
 * coverage as evidence that the image is featureless. */
export function backgroundRaster(page: PDFPage, op: ContentOp) {
  const name = op.operands[0];
  let resources = page.node.Resources();
  let member = name?.kind === 'name' ? name.value : undefined;
  const seen = new Set<PDFRawStream>();
  try {
    while (member && seen.size < 8) {
      const raw = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict)?.lookup(PDFName.of(member));
      if (!(raw instanceof PDFRawStream) || seen.has(raw)) return;
      const subtype = raw.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText();
      if (subtype === 'Image') return raw;
      if (subtype !== 'Form') return;
      seen.add(raw);
      const ops = tokenizeContentStream(decoded(raw));
      const calls = ops.filter(o => o.operator === 'Do');
      const next = calls[0]?.operands[0];
      if (ops.some(o => !rasterScopeOps.has(o.operator)) || calls.length !== 1 || next?.kind !== 'name') return;
      resources = raw.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) ?? resources;
      member = next.value;
    }
  } catch {
    return;
  }
}

const decoded = (raw: PDFRawStream) => raw.dict.has(PDFName.of('Filter'))
  ? decodePDFRawStream(raw).decode() : raw.getContents();

// Summed masks of abrupt local transitions. Adjacent samples make this a
// test of printed detail, rather than of the overall slope of a photograph.
function backdropEdges(data: Uint8ClampedArray, width: number, height: number) {
  const stride = width + 1;
  const near = new Uint32Array(stride * (height + 1)), strong = new Uint32Array(near.length);
  for (let y = 0; y < height - 1; y++) {
    let rowNear = 0, rowStrong = 0;
    for (let x = 0; x < width; x++) {
      const i = 4 * (y * width + x), cell = (y + 1) * stride + x + 1;
      const right = x + 1 < width ? 4 : 0;
      const edge = Math.max(colorDelta(data, data, i, i + right),
        colorDelta(data, data, i, i + width * 4), colorDelta(data, data, i, i + width * 4 + right));
      rowNear += +(edge > 16);
      rowStrong += +(edge > 32);
      near[cell] = near[cell - stride]! + rowNear;
      strong[cell] = strong[cell - stride]! + rowStrong;
    }
  }
  const has = (plane: Uint32Array, x: number, y: number, radius: number) => {
    const left = x - radius, right = x + radius + 1, top = (y - radius) * stride, bottom = (y + radius + 1) * stride;
    return plane[bottom + right]! - plane[bottom + left]! - plane[top + right]! + plane[top + left]! > 0;
  };
  return (x: number, y: number, scale: number) => has(near, x, y, scale) || has(strong, x, y, 3 * scale);
}

/** Test only newly covered pixels. The third rendering exposes underlying
 * paint, including image detail, in the same paint order and coordinate
 * frame. Only locally low-contrast backdrop is eligible. */
export async function verifyFittedBackdrop(page: PDFPage, frame: PdfRect, ink: readonly PdfRect[], source: Uint8Array,
  replacement: Uint8Array, bare: Uint8Array, render: ContactRenderer) {
  const box = bounds(ink.flatMap(r => [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y + r.h }]));
  const scale = 8, radius = 3 * scale;
  const region = contentTextRasterRegion(frame, { x: box.x - 4, y: box.y - 4, w: box.w + 8, h: box.h + 8 }, scale);
  if (!region || page.getRotation().angle) return false;
  try {
    const images = await Promise.all([source, replacement, bare].map(async stream =>
      render(await saveRasterProbe(page, stream), 0, region, scale)));
    if (images.some(raster => !matchesRasterRegion(raster, region))) return false;
    const [before, after, under] = images.map(raster => raster.data) as [Uint8ClampedArray, Uint8ClampedArray, Uint8ClampedArray];
    const hasEdge = backdropEdges(under, region.width, region.height);
    let checked = 0;
    for (let i = 0; i < after.length; i += 4) {
      if (colorDelta(after, before, i) <= 8 || colorDelta(after, under, i) <= 12) continue;
      const old = colorDelta(before, under, i);
      if (old >= colorDelta(after, under, i) - 8) continue;
      const x = i / 4 % region.width, y = Math.floor(i / 4 / region.width);
      if (x < radius || y < radius || x + radius >= region.width || y + radius >= region.height - 1) return false;
      checked++;
      if (hasEdge(x, y, scale)) return false;
    }
    return checked > 0;
  } catch {
    return false;
  }
}
