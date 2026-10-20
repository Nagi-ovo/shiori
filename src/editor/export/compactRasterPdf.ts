import { PDFDocument } from "pdf-lib";
import { appPdfEngine } from "../../pdf/engine/appEngine";
import type { PdfDocument, PdfEngine } from "../../pdf/engine/types";
import { releaseCanvasBackingStore } from "../../pdf/render/canvasMemory";
import type { DocumentModel } from "../../pdf/model/types";
import { isBlankPage } from "../../pdf/model/types";
import { rotatedSize } from "../../pdf/geometry/coords";
import {
  MAX_CANVAS_PIXELS,
  assertCanvasPixelBudget,
  clampScaleToCanvasBudget,
} from "../../pdf/openPolicy";
import {
  drawThumbnailOverlays,
  loadThumbnailOverlayFonts,
} from "../components/thumbnailCompositor";
import { loadThumbnailOverlayImages } from "../components/thumbnailImages";
import type { ExportMode } from "../../pdf/export/exportPdf";

const COMPACT_TARGET_DPI = 120;
const COMPACT_JPEG_QUALITY = 0.68;
const POINTS_PER_INCH = 72;

type CompactRasterPdfOptions = {
  mode: ExportMode;
};

/**
 * A raster copy of the document for the compact quality: each page drawn by
 * the app's engine at about 120 dpi, Shiori's overlays painted on top, and
 * saved as JPEG. "none" keeps the page content alone, without the source's
 * annotations or form fields.
 */
export async function exportCompactRasterPdf(
  doc: PdfDocument,
  model: DocumentModel,
  options: CompactRasterPdfOptions,
  engine: Pick<PdfEngine, "renderRegion"> = appPdfEngine,
): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  const includeOverlays = options.mode !== "none";
  if (includeOverlays) {
    await loadThumbnailOverlayFonts(model.overlays);
  }

  for (const pageModel of model.pages) {
    const size = rotatedSize(
      pageModel.widthPt,
      pageModel.heightPt,
      pageModel.rotation,
    );
    const scale = compactScaleForPage(size.width, size.height);
    const widthPx = Math.max(1, Math.ceil(size.width * scale));
    const heightPx = Math.max(1, Math.ceil(size.height * scale));
    assertCanvasPixelBudget(widthPx, heightPx, MAX_CANVAS_PIXELS);

    const canvas = document.createElement("canvas");
    try {
      canvas.width = widthPx;
      canvas.height = heightPx;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Unable to create export canvas.");
      ctx.fillStyle = "#fffdf8";
      ctx.fillRect(0, 0, widthPx, heightPx);

      if (!isBlankPage(pageModel)) {
        await engine.renderRegion(
          doc,
          {
            sourceIndex: pageModel.sourceIndex,
            rotation: pageModel.rotation,
            scale,
            dpr: 1,
            region: { x: 0, y: 0, width: widthPx, height: heightPx },
            priority: "backdrop",
            annotations: options.mode !== "none",
          },
          canvas,
        ).done;
      }

      if (includeOverlays) {
        const overlays = model.overlays.filter(
          (overlay) => overlay.pageId === pageModel.id,
        );
        // One page's images at a time: a photo on every page of a long
        // document would otherwise stay decoded until the whole export ends.
        const images = await loadThumbnailOverlayImages(overlays);
        drawThumbnailOverlays(
          ctx,
          pageModel,
          overlays,
          {
            width: widthPx,
            height: heightPx,
            scale,
          },
          images,
        );
      }

      const jpgBytes = await canvasToJpegBytes(canvas, COMPACT_JPEG_QUALITY);
      const image = await out.embedJpg(jpgBytes);
      const outPage = out.addPage([size.width, size.height]);
      outPage.drawImage(image, {
        x: 0,
        y: 0,
        width: size.width,
        height: size.height,
      });
    } finally {
      releaseCanvasBackingStore(canvas);
    }
  }

  return out.save({ useObjectStreams: true });
}

function compactScaleForPage(widthPt: number, heightPt: number): number {
  const targetScale = COMPACT_TARGET_DPI / POINTS_PER_INCH;
  const scale = clampScaleToCanvasBudget(
    targetScale,
    widthPt,
    heightPt,
    1,
    MAX_CANVAS_PIXELS,
  );
  return Math.max(0.1, scale);
}

async function canvasToJpegBytes(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Uint8Array> {
  if (typeof canvas.toBlob === "function") {
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) => {
          if (result) resolve(result);
          else reject(new Error("Unable to encode compact PDF page."));
        },
        "image/jpeg",
        quality,
      );
    });
    return new Uint8Array(await blob.arrayBuffer());
  }

  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  const comma = dataUrl.indexOf(",");
  const raw = atob(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}
