import { isBlankPage, type Overlay, type PageModel } from "../../pdf/model/types";
import type { PdfDocument } from "../../pdf/engine/types";
import { appPdfEngine } from "../../pdf/engine/appEngine";
import { rotatedSize } from "../../pdf/geometry/coords";
import { MAX_CANVAS_PIXELS } from "../../pdf/openPolicy";
import { renderPageBackdrop } from "../../pdf/render/tiles";
import { compositePdfPaperColor } from "../../design/pdfPaperTone";
import {
  THUMBNAIL_TARGET_WIDTH,
  drawThumbnailOverlays,
  drawThumbnailPaper,
  fitThumbnailCanvasToTile,
  loadThumbnailOverlayFonts,
  prepareThumbnailCanvas,
  thumbnailViewportForPage,
} from "./thumbnailCompositor";
import { loadThumbnailOverlayImages } from "./thumbnailImages";

export type ThumbnailPaintJob = {
  /** Read after each await: the tile may have unmounted meanwhile. */
  canvas: () => HTMLCanvasElement | null;
  doc: PdfDocument;
  page: PageModel;
  overlays: Overlay[];
  paperColor: string | null;
  cancelled: () => boolean;
  /** Receives the page render as it starts, so the caller can cancel it. */
  onBackdrop: (handle: ReturnType<typeof renderPageBackdrop>) => void;
};

/**
 * Paints one sidebar tile: the page (or blank paper), the paper tone, then
 * the overlays. Resolves true once the tile shows the page, false when it
 * was cancelled or had nothing to paint into.
 */
export async function paintThumbnail(job: ThumbnailPaintJob): Promise<boolean> {
  const { page, overlays, paperColor } = job;
  // Placed images and signatures are decoded per paint, not cached: a
  // module-wide cache would keep every pasted image alive for the session.
  const [, images] = await Promise.all([
    loadThumbnailOverlayFonts(overlays),
    loadThumbnailOverlayImages(overlays, { skipUndecodable: true }),
  ]);
  if (job.cancelled()) return false;
  const canvas = job.canvas();
  if (!canvas) return false;
  if (isBlankPage(page)) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    const viewport = prepareThumbnailCanvas(
      canvas,
      page,
      THUMBNAIL_TARGET_WIDTH,
    );
    drawThumbnailPaper(ctx, viewport);
    compositePdfPaperColor(ctx, canvas.width, canvas.height, paperColor);
    drawThumbnailOverlays(ctx, page, overlays, viewport, images);
    return true;
  }

  const viewport = thumbnailViewportForPage(page, THUMBNAIL_TARGET_WIDTH);
  const size = rotatedSize(page.widthPt, page.heightPt, page.rotation);
  const handle = renderPageBackdrop(
    appPdfEngine.renderRegion,
    job.doc,
    {
      sourceIndex: page.sourceIndex,
      rotation: page.rotation,
      scale: viewport.scale,
      widthPt: size.width,
      heightPt: size.height,
      dpr: window.devicePixelRatio || 1,
      maxPixels: MAX_CANVAS_PIXELS,
      priority: "thumbnail",
    },
    canvas,
  );
  job.onBackdrop(handle);
  await handle.done;
  if (job.cancelled()) return false;
  fitThumbnailCanvasToTile(canvas);
  const ctx = canvas.getContext("2d");
  if (ctx) {
    compositePdfPaperColor(ctx, canvas.width, canvas.height, paperColor);
    drawThumbnailOverlays(ctx, page, overlays, viewport, images);
  }
  return true;
}
