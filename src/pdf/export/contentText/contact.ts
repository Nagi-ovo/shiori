import { PDFDocument, type PDFPage } from 'pdf-lib';
import type { ContentTextOverlay, PdfRect } from '../../model/types';
import { colorDelta, contentTextRasterRegion, matchesRasterRegion, type ContactRenderer, type Raster, type RasterRegion } from './contentTextRaster';
import { compactContactText, contactProbe, findContactTarget, inspectContactScene, unsupportedPaintAt } from './contactScene';
import { bounds } from './retypesetInk';

export type ContentTextContact =
  | { kind: 'new-collision'; region: PdfRect }
  | { kind: 'pre-existing-contact' | 'clear' | 'uncertain'; region?: PdfRect };

function compare(region: RasterRegion, pageHeight: number, scale: number, rasters: Raster[], hasEditedInk: boolean): ContentTextContact {
  if (rasters.some(r => !matchesRasterRegion(r, region))) return { kind: 'uncertain' };
  const [before, after, substrate, revisedSubstrate, stationary, revisedStationary, original, edited] = rasters.map(r => r.data);
  const beforeContact = new Uint8Array(region.width * region.height);
  const afterContact = new Uint8Array(beforeContact.length);
  let old = 0, next = 0, visibleBefore = 0, visibleAfter = 0;
  const overlaps = (target: Uint8ClampedArray, composite: Uint8ClampedArray, base: Uint8ClampedArray, foreign: Uint8ClampedArray, i: number) => {
    const text = colorDelta(target, base, i) > 32;
    const obstacle = colorDelta(foreign, base, i) > 32;
    // If one layer matches the background, its footprint can still be
    // proved by the ink it hides in the full composite.
    if (text && obstacle) return true;
    return (text && colorDelta(composite, target, i) > 32) ||
      (obstacle && colorDelta(composite, foreign, i) > 32);
  };
  for (let p = 0; p < beforeContact.length; p++) {
    const i = p * 4;
    beforeContact[p] = +overlaps(original!, before!, substrate!, stationary!, i);
    afterContact[p] = +overlaps(edited!, after!, revisedSubstrate!, revisedStationary!, i);
    old += beforeContact[p]!;
    next += afterContact[p]!;
    visibleBefore += +(colorDelta(original!, substrate!, i) > 32 || !!beforeContact[p]);
    visibleAfter += +(colorDelta(edited!, revisedSubstrate!, i) > 32 || !!afterContact[p]);
  }
  if (!visibleBefore || hasEditedInk && !visibleAfter) return { kind: 'uncertain' };
  // A one-pixel move at an existing contact may come from antialiasing.
  // Count a newly occupied place as well as growth at an existing contact.
  let added = 0, distinct = 0, minX = region.width, minY = region.height, maxX = -1, maxY = -1;
  for (let p = 0; p < beforeContact.length; p++) {
    if (!afterContact[p] || beforeContact[p]) continue;
    const x = p % region.width, y = Math.floor(p / region.width);
    const near = (x > 0 && beforeContact[p - 1]) || (x + 1 < region.width && beforeContact[p + 1]) ||
      beforeContact[p - region.width] || beforeContact[p + region.width];
    distinct += +!near;
    added++;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  const minimum = Math.max(2, Math.ceil(.07 * scale * scale));
  if (distinct >= minimum || added >= minimum && next >= old + minimum) {
    // Publish visual bounds in quarter points, leaving fine raster samples
    // for the evidence. The overlay stays stable across raster resolutions.
    const snap = (v: number) => Math.round(v * 4) / 4;
    const x = snap((region.x + minX) / scale), y = snap(pageHeight - (region.y + maxY + 1) / scale);
    return { kind: 'new-collision', region: { x, y,
      w: Math.max(.25, snap((region.x + maxX + 1) / scale) - x),
      h: Math.max(.25, snap(pageHeight - (region.y + minY) / scale) - y),
    } };
  }
  if (old >= minimum) return { kind: 'pre-existing-contact' };
  return { kind: old || next ? 'uncertain' : 'clear' };
}

/** Compare attributed before and after ink in each revision's actual paint
 * order. The row remains uncertain when the selected occurrence or its
 * local counterpart cannot be established. */
export async function assessContentTextContact(source: PDFDocument, index: number,
  revision: Uint8Array, overlay: ContentTextOverlay, render: ContactRenderer): Promise<ContentTextContact> {
  try {
    return await assessContentTextPageContact(source.getPage(index), (await PDFDocument.load(revision)).getPage(0), overlay, render);
  } catch {
    return { kind: 'uncertain' };
  }
}

export async function assessContentTextPageContact(source: PDFPage, revision: PDFPage,
  overlay: ContentTextOverlay, render: ContactRenderer): Promise<ContentTextContact> {
  const uncertain: ContentTextContact = { kind: 'uncertain' };
  try {
    const original = inspectContactScene(source);
    const revised = inspectContactScene(revision);
    if (!original || !revised || Object.keys(original.frame).some(key =>
      original.frame[key as keyof PdfRect] !== revised.frame[key as keyof PdfRect])) return uncertain;
    const before = findContactTarget(original, overlay, overlay.originalText, null);
    const after = before && findContactTarget(revised, overlay, overlay.text, before);
    if (!before || !after) return uncertain;
    const box = bounds([before.footprint, after.footprint].flatMap(r => [
      { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y + r.h },
    ]));
    const probeBox = { x: box.x - 1, y: box.y - 1, w: box.w + 2, h: box.h + 2 };
    if (unsupportedPaintAt(original, probeBox) || unsupportedPaintAt(revised, probeBox)) return uncertain;
    const chosen = [16, 12, 8, 4].map(scale => ({ scale, region: contentTextRasterRegion(original.frame, probeBox, scale) }))
      .find(sample => sample.region);
    if (!chosen?.region) return uncertain;
    const { scale, region } = chosen;
    const measure = async (scene: typeof original, target: typeof before) => {
      const sample = async (layer: Parameters<typeof contactProbe>[2]) =>
        render(await contactProbe(scene, target, layer), 0, region, scale);
      const [composite, stationary, artwork] = await Promise.all([
        sample('composite'), sample('counterpart'), sample('artwork'),
      ]);
      // A field can have several fills below it. When the renderer shows
      // that all graphics in this local frame are flat, keep that actual
      // substrate for both the target and counterpart comparisons.
      let flat = matchesRasterRegion(artwork, region);
      for (let i = 4; flat && i < artwork.data.length; i += 4) flat = colorDelta(artwork.data, artwork.data, i, 0) <= 8;
      const [substrate, ink] = await Promise.all([
        flat ? artwork : sample('substrate'), sample(flat ? 'target-over-artwork' : 'target'),
      ]);
      return [composite, substrate, stationary, ink];
    };
    const [left, right] = await Promise.all([measure(original, before), measure(revised, after)]);
    return compare(region, original.frame.h, scale, left.flatMap((r, i) => [r, right[i]!]), !!compactContactText(overlay.text));

  } catch {
    return uncertain;
  }
}
