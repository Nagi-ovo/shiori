import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {pdfRectToDisplay} from '../../src/pdf/geometry/coords';
import type {PdfRect, Rotation} from '../../src/pdf/model/types';

export type Image = {width: number; height: number; rgba: Buffer};
type PageRaster = {width: number; height: number; pixels?: Uint8Array};

/** PDFium renders at 144 dpi in BGRA. Edit rectangles are relative to the
 * unrotated visible page box, as in the app, with a bottom-left origin. */
export function cropPage(page: PageRaster, rects: readonly PdfRect[], rotation: Rotation, margin = 8) {
  assert(page.pixels, 'native raster missing');
  assert(rects.length, 'edit has no cover/paragraph rects');
  assert(Number.isFinite(margin) && margin >= 0, 'invalid margin');
  assert([0, 90, 180, 270].includes(rotation), 'unsupported page rotation');
  for (const r of rects) assert([r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0 && r.h > 0, 'invalid edit rect');
  const width = Math.round(page.width * 2), height = Math.round(page.height * 2);
  assert.equal(page.pixels.length, width * height * 4, 'native raster dimensions differ');
  const unrotatedWidth = rotation === 90 || rotation === 270 ? page.height : page.width;
  const unrotatedHeight = rotation === 90 || rotation === 270 ? page.width : page.height;
  const displayed = rects.map(r => pdfRectToDisplay(r, unrotatedWidth, unrotatedHeight, rotation, 1));
  const left = Math.min(...displayed.map(r => r.x)) - margin;
  const top = Math.min(...displayed.map(r => r.y)) - margin;
  const right = Math.max(...displayed.map(r => r.x + r.w)) + margin;
  const bottom = Math.max(...displayed.map(r => r.y + r.h)) + margin;
  const x = Math.max(0, Math.floor(left * width / page.width));
  const y = Math.max(0, Math.floor(top * height / page.height));
  const w = Math.min(width, Math.ceil(right * width / page.width)) - x;
  const h = Math.min(height, Math.ceil(bottom * height / page.height)) - y;
  assert(w > 0 && h > 0, 'edit crop is outside the page');
  const rgba = Buffer.alloc(w * h * 4);
  for (let row = 0; row < h; row++) for (let column = 0; column < w; column++) {
    const src = ((y + row) * width + x + column) * 4, dst = (row * w + column) * 4;
    rgba[dst] = page.pixels[src + 2]!;
    rgba[dst + 1] = page.pixels[src + 1]!;
    rgba[dst + 2] = page.pixels[src]!;
    rgba[dst + 3] = page.pixels[src + 3]!;
  }
  return {width: w, height: h, rgba, bounds: {x, y, w, h}};
}

/** Before is on the left, after on the right, separated by a white gutter. */
export function pairImages(before: Image, after: Image): Image {
  const width = before.width + 12 + after.width, height = Math.max(before.height, after.height);
  const rgba = Buffer.alloc(width * height * 4, 255);
  for (const [image, x] of [[before, 0], [after, before.width + 12]] as const) {
    for (let y = 0; y < image.height; y++) image.rgba.copy(rgba, (y * width + x) * 4, y * image.width * 4, (y + 1) * image.width * 4);
  }
  return {width, height, rgba};
}

function chunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, checksum]);
}

/** Minimal lossless RGBA PNG, using the standard zlib stream and CRC32. */
export function encodePng(image: Image) {
  assert(image.width > 0 && image.height > 0 && image.rgba.length === image.width * image.height * 4, 'invalid PNG dimensions');
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0); header.writeUInt32BE(image.height, 4);
  header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((image.width * 4 + 1) * image.height);
  for (let y = 0; y < image.height; y++) image.rgba.copy(rows, y * (image.width * 4 + 1) + 1, y * image.width * 4, (y + 1) * image.width * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
