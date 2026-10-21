import type { Overlay } from "../../pdf/model/types";

/** Decoded image overlays, by data URL, ready for a synchronous canvas draw. */
export type ThumbnailImages = ReadonlyMap<string, CanvasImageSource>;

/**
 * Decodes every image overlay (placed images, image signatures) before the
 * canvas draw, the way loadThumbnailOverlayFonts loads fonts: drawing is
 * synchronous and cannot wait for a decode. Rejects when an image will not
 * decode, so compact export falls back to the standard copy rather than
 * saving a page without it. With `skipUndecodable` (sidebar tiles, which
 * have no fallback) such an image is left out and the rest still paints.
 */
export async function loadThumbnailOverlayImages(
  overlays: readonly Overlay[],
  { skipUndecodable = false }: { skipUndecodable?: boolean } = {},
): Promise<ThumbnailImages> {
  const images = new Map<string, CanvasImageSource>();
  const urls = new Set<string>();
  for (const overlay of overlays) {
    if (overlay.type === "image") urls.add(overlay.dataUrl);
  }
  await Promise.all(
    Array.from(urls, async (url) => {
      const image = document.createElement("img");
      image.src = url;
      try {
        await image.decode();
      } catch (error) {
        if (skipUndecodable) return;
        throw error;
      }
      images.set(url, image);
    }),
  );
  return images;
}
