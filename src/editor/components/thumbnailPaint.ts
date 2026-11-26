import {
  isBlankPage,
  type Overlay,
  type PageModel,
  type TextFlowChain,
} from "../../pdf/model/types";
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
import { prepareContentTextPreview } from "./contentTextPreview";

export type ThumbnailPaintJob = {
  /** Read after each await: the tile may have unmounted meanwhile. */
  canvas: () => HTMLCanvasElement | null;
  doc: PdfDocument;
  /** The opened document's bytes, for the page content writer; never edited. */
  sourceBytes: Uint8Array | null;
  page: PageModel;
  overlays: Overlay[];
  /** Linked text frames, so a chained edit's tile shows the flowed page. */
  flowChains?: readonly TextFlowChain[];
  paperColor: string | null;
  cancelled: () => boolean;
  /** Receives the page render as it starts, so the caller can cancel it. */
  onBackdrop: (handle: ReturnType<typeof renderPageBackdrop>) => void;
};

/**
 * Paints one sidebar tile: the page (or blank paper), the paper tone, then
 * the overlays. Edits to the page's content arrive inside the page raster.
 * Resolves true once the tile shows the page, false when it was cancelled
 * or had nothing to paint into.
 */
export async function paintThumbnail(job: ThumbnailPaintJob): Promise<boolean> {
  const { page, overlays, sourceBytes } = job;
  // Placed images and signatures are decoded per paint, not cached: a
  // module-wide cache would keep every pasted image alive for the session.
  const written = loadWrittenPage(job.doc, sourceBytes, page, overlays, job.flowChains);
  try {
    const [, images] = await Promise.all([
      loadThumbnailOverlayFonts(overlays),
      loadThumbnailOverlayImages(overlays, { skipUndecodable: true }),
    ]);
    return await paintLoaded(job, images, await written);
  } finally {
    const doc = await written;
    if (doc) await appPdfEngine.destroy(doc.doc);
  }
}

/**
 * The page as the shared page content writer (the one export uses) writes
 * its accepted edits, opened from a copy; the opened bytes stay untouched.
 * Null when the page has no such edit, every edit was refused, or the
 * preview is unavailable: the tile then shows the genuine source page.
 * Same inputs as the editor surface, so both share one cached rebuild.
 */
type WrittenPage = { doc: PdfDocument; pageIndex: number };

async function loadWrittenPage(
  sourceDoc: PdfDocument,
  source: Uint8Array | null,
  page: PageModel,
  overlays: readonly Overlay[],
  flowChains?: readonly TextFlowChain[],
): Promise<WrittenPage | null> {
  const edits = overlays.filter(o => o.type === "contentText" || o.type === "sourceImageEdit");
  if (!edits.length || !source || isBlankPage(page)) return null;
  try {
    const preview = await prepareContentTextPreview(source, page, edits, sourceDoc, { flowChains }).build();
    if (!preview.bytes) return null;
    return { doc: (await appPdfEngine.load(preview.bytes, {})).doc, pageIndex: preview.pageIndex ?? 0 };
  } catch {
    return null;
  }
}

async function paintLoaded(
  job: ThumbnailPaintJob,
  images: Awaited<ReturnType<typeof loadThumbnailOverlayImages>>,
  written: WrittenPage | null,
): Promise<boolean> {
  const { page, overlays, paperColor } = job;
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
    written?.doc ?? job.doc,
    {
      sourceIndex: written?.pageIndex ?? page.sourceIndex,
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
