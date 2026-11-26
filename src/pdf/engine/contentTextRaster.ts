import type { ContactRenderer } from '../export/contentText/contentTextRaster';
import type { PdfEngine } from './types';

export function createContentTextRenderer(engine: PdfEngine): ContactRenderer {
  return async (bytes, sourceIndex, region, scale) => {
    const { doc } = await engine.load(bytes, {});
    try {
      const canvas = document.createElement('canvas');
      await engine.renderRegion(doc, { sourceIndex, rotation: 0, scale, dpr: 1, region, priority: 'backdrop' }, canvas).done;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw Error('Content text raster unavailable');
      return context.getImageData(0, 0, region.width, region.height);
    } finally {
      await engine.destroy(doc);
    }
  };
}
