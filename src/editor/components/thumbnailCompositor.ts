import type {
  CalloutOverlay,
  ContentTextOverlay,
  HighlightOverlay,
  ImageOverlay,
  InkOverlay,
  NoteOverlay,
  Overlay,
  PageModel,
  PdfRect,
  RectOverlay,
  StampOverlay,
  StrikeOutOverlay,
  TextOverlay,
  UnderlineOverlay,
} from "../../pdf/model/types";
import {
  CALLOUT_LABEL_PADDING_X_PT,
  CALLOUT_LABEL_PADDING_Y_PT,
  CALLOUT_TARGET_OPACITY,
  calloutConnectorGeometry,
} from "../../pdf/model/callout";
import {
  pdfRectToDisplay,
  pdfToDisplay,
  rotatedSize,
} from "../../pdf/geometry/coords";
import { baseTextDirection } from "../../pdf/export/textScripts";
import { canvasFontShorthand, wrapThumbnailText } from "./thumbnailText";
import type { ThumbnailImages } from "./thumbnailImages";
import {
  MAX_THUMBNAIL_CANVAS_PIXELS,
  isCanvasWithinPixelBudget,
} from "../../pdf/openPolicy";

export {
  loadThumbnailOverlayFonts,
  wrapThumbnailText,
} from "./thumbnailText";

export const THUMBNAIL_TARGET_WIDTH = 168;
export const THUMBNAIL_PAPER = "#fffdf8";

export type ThumbnailViewport = {
  width: number;
  height: number;
  scale: number;
};

export function thumbnailRotatedBoxPlacement(
  page: PageModel,
  rect: PdfRect,
  scale: number,
): { centerX: number; centerY: number; width: number; height: number; radians: number } {
  const center = pdfToDisplay(
    { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 },
    page.widthPt,
    page.heightPt,
    page.rotation,
    scale,
  );
  return {
    centerX: center.x,
    centerY: center.y,
    width: rect.w * scale,
    height: rect.h * scale,
    radians: (page.rotation * Math.PI) / 180,
  };
}

export function thumbnailViewportForPage(
  page: PageModel,
  targetWidth: number = THUMBNAIL_TARGET_WIDTH,
  maxPixels: number = MAX_THUMBNAIL_CANVAS_PIXELS,
  dpr: number = devicePixelRatioSafe(),
): ThumbnailViewport {
  const size = rotatedSize(page.widthPt, page.heightPt, page.rotation);
  const requestedWidth = Math.max(1, targetWidth);
  const requestedScale = requestedWidth / Math.max(1, size.width);
  const requestedHeight = Math.max(1, size.height * requestedScale);
  const safeDpr = Math.max(1, dpr || 1);
  const requestedBitmapWidth = Math.max(1, Math.ceil(requestedWidth * safeDpr));
  const requestedBitmapHeight = Math.max(1, Math.ceil(requestedHeight * safeDpr));
  if (
    isCanvasWithinPixelBudget(
      requestedBitmapWidth,
      requestedBitmapHeight,
      maxPixels,
    )
  ) {
    return {
      width: requestedWidth,
      height: requestedHeight,
      scale: requestedScale,
    };
  }

  const fitRatio = Math.sqrt(
    maxPixels / Math.max(1, requestedBitmapWidth * requestedBitmapHeight),
  );
  const width = Math.max(1, Math.floor(requestedWidth * fitRatio));
  const scale = width / Math.max(1, size.width);
  return {
    width,
    height: Math.max(1, size.height * scale),
    scale,
  };
}

export function prepareThumbnailCanvas(
  canvas: HTMLCanvasElement,
  page: PageModel,
  targetWidth: number = THUMBNAIL_TARGET_WIDTH,
  dpr: number = devicePixelRatioSafe(),
): ThumbnailViewport {
  const viewport = thumbnailViewportForPage(
    page,
    targetWidth,
    MAX_THUMBNAIL_CANVAS_PIXELS,
    dpr,
  );
  const safeDpr = Math.max(1, dpr || 1);
  const width = Math.max(1, Math.ceil(viewport.width * safeDpr));
  const height = Math.max(1, Math.ceil(viewport.height * safeDpr));
  if (!isCanvasWithinPixelBudget(width, height, MAX_THUMBNAIL_CANVAS_PIXELS)) {
    throw new Error(`Thumbnail canvas would be ${width}×${height} px`);
  }
  canvas.width = width;
  canvas.height = height;
  fitThumbnailCanvasToTile(canvas);
  return viewport;
}

export function fitThumbnailCanvasToTile(canvas: HTMLCanvasElement): void {
  canvas.style.width = "100%";
  canvas.style.height = "100%";
}

export function drawThumbnailPaper(
  ctx: CanvasRenderingContext2D,
  viewport: ThumbnailViewport,
): void {
  withCssPixels(ctx, viewport, () => {
    ctx.fillStyle = THUMBNAIL_PAPER;
    ctx.fillRect(0, 0, viewport.width, viewport.height);
  });
}

export function drawThumbnailOverlays(
  ctx: CanvasRenderingContext2D,
  page: PageModel,
  overlays: Overlay[],
  viewport: ThumbnailViewport,
  /** From loadThumbnailOverlayImages; an image missing here is skipped. */
  images: ThumbnailImages = new Map(),
): void {
  if (overlays.length === 0) return;
  withCssPixels(ctx, viewport, () => {
    ctx.beginPath();
    ctx.rect(0, 0, viewport.width, viewport.height);
    ctx.clip();
    for (const overlay of overlays) {
      if (overlay.type === "contentText") {
        drawContentText(ctx, page, overlay, viewport.scale);
      }
    }
    for (const overlay of overlays) {
      if (overlay.type === "contentText") continue;
      if (overlay.type === "highlight") drawHighlight(ctx, page, overlay, viewport.scale);
      else if (overlay.type === "underline") drawUnderline(ctx, page, overlay, viewport.scale);
      else if (overlay.type === "strikethrough") drawStrikeOut(ctx, page, overlay, viewport.scale);
      else if (overlay.type === "rect") drawRect(ctx, page, overlay, viewport.scale);
      else if (overlay.type === "stamp") drawStamp(ctx, page, overlay, viewport.scale);
      else if (overlay.type === "ink") drawInk(ctx, page, overlay, viewport.scale);
      else if (overlay.type === "text") drawText(ctx, page, overlay, viewport.scale);
      else if (overlay.type === "note") drawNote(ctx, page, overlay, viewport.scale);
      else if (overlay.type === "callout") drawCallout(ctx, page, overlay, viewport.scale);
      else if (overlay.type === "image") drawImage(ctx, page, overlay, viewport.scale, images);
    }
  });
}

function drawHighlight(
  ctx: CanvasRenderingContext2D,
  page: PageModel,
  overlay: HighlightOverlay,
  scale: number,
): void {
  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = overlay.color;
  ctx.globalAlpha = Math.max(0.32, Math.min(1, overlay.opacity));
  for (const rect of overlay.rects) {
    const d = pdfRectToDisplay(
      rect,
      page.widthPt,
      page.heightPt,
      page.rotation,
      scale,
    );
    fillRoundRect(ctx, d.x, d.y, d.w, d.h, 1.2);
  }
  ctx.restore();
}

function drawUnderline(
  ctx: CanvasRenderingContext2D,
  page: PageModel,
  overlay: UnderlineOverlay,
  scale: number,
): void {
  drawTextLineMarkup(ctx, page, overlay, scale, underlineDisplayY);
}

function drawStrikeOut(
  ctx: CanvasRenderingContext2D,
  page: PageModel,
  overlay: StrikeOutOverlay,
  scale: number,
): void {
  drawTextLineMarkup(ctx, page, overlay, scale, strikethroughDisplayY);
}

function drawTextLineMarkup(
  ctx: CanvasRenderingContext2D,
  page: PageModel,
  overlay: UnderlineOverlay | StrikeOutOverlay,
  scale: number,
  lineY: (rect: { y: number; h: number }) => number,
): void {
  ctx.save();
  ctx.strokeStyle = overlay.color;
  ctx.globalAlpha = Math.max(0.1, Math.min(1, overlay.opacity));
  for (const rect of overlay.rects) {
    const d = pdfRectToDisplay(
      rect,
      page.widthPt,
      page.heightPt,
      page.rotation,
      scale,
    );
    const y = lineY(d);
    ctx.lineWidth = Math.max(1, Math.min(3, d.h * 0.08));
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(d.x, y);
    ctx.lineTo(d.x + d.w, y);
    ctx.stroke();
  }
  ctx.restore();
}

function underlineDisplayY(rect: { y: number; h: number }): number {
  return rect.y + rect.h - Math.max(1, Math.min(3, rect.h * 0.12));
}

function strikethroughDisplayY(rect: { y: number; h: number }): number {
  return rect.y + rect.h * 0.55;
}

function drawRect(
  ctx: CanvasRenderingContext2D,
  page: PageModel,
  overlay: RectOverlay,
  scale: number,
): void {
  const d = pdfRectToDisplay(
    overlay.rect,
    page.widthPt,
    page.heightPt,
    page.rotation,
    scale,
  );
  ctx.save();
  if (overlay.fill) {
    ctx.fillStyle = overlay.fill;
    fillRoundRect(ctx, d.x, d.y, d.w, d.h, 1.5);
  }
  ctx.strokeStyle = overlay.color;
  ctx.lineWidth = Math.max(1, overlay.strokeWidth * scale);
  strokeRoundRect(ctx, d.x, d.y, d.w, d.h, 1.5);
  ctx.restore();
}

function drawStamp(
  ctx: CanvasRenderingContext2D,
  page: PageModel,
  overlay: StampOverlay,
  scale: number,
): void {
  const d = pdfRectToDisplay(
    overlay.rect,
    page.widthPt,
    page.heightPt,
    page.rotation,
    scale,
  );
  ctx.save();
  ctx.strokeStyle = overlay.color;
  ctx.lineWidth = Math.max(1.5, overlay.strokeWidth * scale);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  traceStamp(ctx, d, overlay.kind);
  ctx.stroke();
  ctx.restore();
}

function drawInk(
  ctx: CanvasRenderingContext2D,
  page: PageModel,
  overlay: InkOverlay,
  scale: number,
): void {
  ctx.save();
  ctx.strokeStyle = overlay.color;
  // Thumbnails clamp hairline strokes up to a visible minimum — a 2pt pen
  // at thumbnail scale would be ~0.2px and vanish. The inflation makes a
  // heavily-annotated page read as one solid blob, so the more a stroke is
  // inflated past its true width, the more transparent it gets: dense
  // handwriting stays legible as a fuzz of color instead of a blot, while
  // barely-clamped (or unclamped) strokes stay fully opaque.
  const trueWidth = overlay.width * scale;
  ctx.lineWidth = Math.max(1.5, trueWidth);
  ctx.globalAlpha = Math.max(0.45, Math.min(1, trueWidth / 1.5));
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const path of overlay.paths) {
    if (path.length < 2) continue;
    ctx.beginPath();
    path.forEach((point, index) => {
      const d = pdfToDisplay(
        point,
        page.widthPt,
        page.heightPt,
        page.rotation,
        scale,
      );
      if (index === 0) ctx.moveTo(d.x, d.y);
      else ctx.lineTo(d.x, d.y);
    });
    ctx.stroke();
  }
  ctx.restore();
}

// Turned with the page and by the overlay's own angle, about its center, as
// the editor shows it (overlaySvg.tsx boxSvgPlacement).
function drawImage(
  ctx: CanvasRenderingContext2D,
  page: PageModel,
  overlay: ImageOverlay,
  scale: number,
  images: ThumbnailImages,
): void {
  const image = images.get(overlay.dataUrl);
  if (!image) return;
  const p = thumbnailRotatedBoxPlacement(page, overlay.rect, scale);
  ctx.save();
  ctx.translate(p.centerX, p.centerY);
  ctx.rotate(p.radians + ((overlay.angle ?? 0) * Math.PI) / 180);
  ctx.drawImage(image, -p.width / 2, -p.height / 2, p.width, p.height);
  ctx.restore();
}

function drawContentText(
  ctx: CanvasRenderingContext2D,
  page: PageModel,
  overlay: ContentTextOverlay,
  scale: number,
): void {
  ctx.save();
  ctx.fillStyle = overlay.backgroundColor;
  for (const rect of overlay.coverRects) {
    const d = pdfRectToDisplay(
      rect,
      page.widthPt,
      page.heightPt,
      page.rotation,
      scale,
    );
    ctx.fillRect(d.x, d.y, d.w, d.h);
  }
  ctx.restore();
  drawText(ctx, page, overlay, scale);
}

function drawCallout(
  ctx: CanvasRenderingContext2D,
  page: PageModel,
  overlay: CalloutOverlay,
  scale: number,
): void {
  ctx.save();
  ctx.fillStyle = overlay.color;
  ctx.globalAlpha = CALLOUT_TARGET_OPACITY;
  for (const rect of overlay.targetRects) {
    const target = pdfRectToDisplay(
      rect,
      page.widthPt,
      page.heightPt,
      page.rotation,
      scale,
    );
    fillRoundRect(ctx, target.x, target.y, target.w, target.h, 1.2);
  }
  ctx.globalAlpha = 1;
  const connector = calloutConnectorGeometry(overlay);
  const from = pdfToDisplay(
    connector.from,
    page.widthPt,
    page.heightPt,
    page.rotation,
    scale,
  );
  const control = pdfToDisplay(
    connector.control,
    page.widthPt,
    page.heightPt,
    page.rotation,
    scale,
  );
  const to = pdfToDisplay(
    connector.to,
    page.widthPt,
    page.heightPt,
    page.rotation,
    scale,
  );
  const left = pdfToDisplay(
    connector.arrowLeft,
    page.widthPt,
    page.heightPt,
    page.rotation,
    scale,
  );
  const right = pdfToDisplay(
    connector.arrowRight,
    page.widthPt,
    page.heightPt,
    page.rotation,
    scale,
  );
  ctx.strokeStyle = overlay.color;
  ctx.lineWidth = Math.max(1, 1.25 * scale);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  if (connector.kind === "polyline") {
    ctx.lineTo(control.x, control.y);
    ctx.lineTo(to.x, to.y);
  } else {
    ctx.quadraticCurveTo(control.x, control.y, to.x, to.y);
  }
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(left.x, left.y);
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(right.x, right.y);
  ctx.stroke();
  const placement = thumbnailRotatedBoxPlacement(page, overlay.rect, scale);
  ctx.translate(placement.centerX, placement.centerY);
  ctx.rotate(placement.radians);
  const label = {
    x: -placement.width / 2,
    y: -placement.height / 2,
    w: placement.width,
    h: placement.height,
  };
  ctx.fillStyle = THUMBNAIL_PAPER;
  fillRoundRect(ctx, label.x, label.y, label.w, label.h, 1.5);
  ctx.strokeStyle = overlay.color;
  ctx.lineWidth = Math.max(0.75, 0.8 * scale);
  strokeRoundRect(ctx, label.x, label.y, label.w, label.h, 1.5);
  drawTextInDisplayRect(
    ctx,
    overlay,
    {
      x: label.x + CALLOUT_LABEL_PADDING_X_PT * scale,
      y: label.y + CALLOUT_LABEL_PADDING_Y_PT * scale,
      w: Math.max(1, label.w - CALLOUT_LABEL_PADDING_X_PT * scale * 2),
      h: Math.max(1, label.h - CALLOUT_LABEL_PADDING_Y_PT * scale * 2),
    },
    scale,
    false,
  );
  ctx.restore();
}

function drawText(
  ctx: CanvasRenderingContext2D,
  page: PageModel,
  overlay: TextOverlay | ContentTextOverlay | CalloutOverlay,
  scale: number,
): void {
  if (!overlay.text) return;
  const d = pdfRectToDisplay(
    overlay.rect,
    page.widthPt,
    page.heightPt,
    page.rotation,
    scale,
  );
  drawTextInDisplayRect(ctx, overlay, d, scale);
}

function drawTextInDisplayRect(
  ctx: CanvasRenderingContext2D,
  overlay: TextOverlay | ContentTextOverlay | CalloutOverlay,
  d: PdfRect,
  scale: number,
  includeDefaultPadding = true,
): void {
  const fontSize = Math.max(5.5, overlay.fontSize * scale);
  const isContentEdit = overlay.type === "contentText";
  const lineHeight = fontSize * (isContentEdit ? 1.2 : 1.25);
  const padding =
    isContentEdit || !includeDefaultPadding ? 0 : Math.max(1, 3 * scale);
  const maxLines = Math.max(1, Math.floor((d.h - padding * 2) / lineHeight));

  ctx.save();
  ctx.beginPath();
  ctx.rect(d.x, d.y, d.w, d.h);
  ctx.clip();
  ctx.fillStyle = overlay.color;
  ctx.font = canvasFontShorthand(overlay, fontSize);
  ctx.textBaseline = "top";
  ctx.textAlign = overlay.align;
  ctx.direction = baseTextDirection(overlay.text);
  const lines = wrapThumbnailText(
    overlay.text,
    Math.max(1, d.w - padding * 2),
    (text) => ctx.measureText(text).width,
    maxLines,
  );
  const x =
    overlay.align === "center"
      ? d.x + d.w / 2
      : overlay.align === "right"
        ? d.x + d.w - padding
        : d.x + padding;
  lines.forEach((line, index) => {
    ctx.fillText(line, x, d.y + padding + index * lineHeight);
  });
  ctx.restore();
}

function drawNote(
  ctx: CanvasRenderingContext2D,
  page: PageModel,
  overlay: NoteOverlay,
  scale: number,
): void {
  const d = pdfRectToDisplay(
    overlay.rect,
    page.widthPt,
    page.heightPt,
    page.rotation,
    scale,
  );
  ctx.save();
  ctx.fillStyle = overlay.color;
  ctx.globalAlpha = 0.82;
  fillRoundRect(ctx, d.x, d.y, d.w, d.h, 1.5);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = "rgba(158,130,40,0.55)";
  ctx.lineWidth = 0.75;
  strokeRoundRect(ctx, d.x, d.y, d.w, d.h, 1.5);

  const pad = Math.max(2, 5 * scale);
  const lineGap = Math.max(3, 10 * scale);
  ctx.strokeStyle = "rgba(58,47,18,0.55)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 3; i += 1) {
    const y = d.y + pad + i * lineGap;
    if (y > d.y + d.h - pad) break;
    ctx.beginPath();
    ctx.moveTo(d.x + pad, y);
    ctx.lineTo(d.x + d.w - pad, y);
    ctx.stroke();
  }
  ctx.restore();
}

function traceStamp(
  ctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; w: number; h: number },
  kind: StampOverlay["kind"],
): void {
  const pt = (rx: number, ryPdf: number) => ({
    x: rect.x + rect.w * rx,
    y: rect.y + rect.h * (1 - ryPdf),
  });
  if (kind === "cross") {
    const a = pt(0.18, 0.18);
    const b = pt(0.82, 0.82);
    const c = pt(0.82, 0.18);
    const d = pt(0.18, 0.82);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.moveTo(c.x, c.y);
    ctx.lineTo(d.x, d.y);
    return;
  }
  const a = pt(0.15, 0.52);
  const b = pt(0.42, 0.28);
  const c = pt(0.85, 0.76);
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.lineTo(c.x, c.y);
}

function fillRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  roundedRectPath(ctx, x, y, w, h, radius);
  ctx.fill();
}

function strokeRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  roundedRectPath(ctx, x, y, w, h, radius);
  ctx.stroke();
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function withCssPixels(
  ctx: CanvasRenderingContext2D,
  viewport: ThumbnailViewport,
  draw: () => void,
): void {
  const dpr = Math.max(1, ctx.canvas.width / Math.max(1, viewport.width));
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
  ctx.restore();
}

function devicePixelRatioSafe(): number {
  if (typeof window === "undefined") return 1;
  return window.devicePixelRatio || 1;
}
