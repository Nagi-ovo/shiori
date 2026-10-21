// Overlays drawn into page content: every flattened overlay, plus the image
// and original-text overlays that the editable mode also burns in.
import {
  BlendMode,
  LineCapStyle,
  LineJoinStyle,
  appendBezierCurve,
  clip,
  concatTransformationMatrix,
  endPath,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
  setLineCap,
  setLineJoin,
  setGraphicsState,
  setLineWidth,
  setStrokingColor,
  stroke,
  type PDFImage,
  type PDFPage,
} from "pdf-lib";
import type {
  CalloutOverlay,
  HighlightOverlay,
  ImageOverlay,
  InkOverlay,
  NoteOverlay,
  Overlay,
  RectOverlay,
  StampOverlay,
  StrikeOutOverlay,
  TextOverlay,
  UnderlineOverlay,
} from "../model/types";
import {
  CALLOUT_TARGET_OPACITY,
  calloutConnectorGeometry,
} from "../model/callout";
import type { ContentTextRedaction } from "./contentTextRedaction";
import type { FontSet } from "./exportFonts";
import { drawContentText, drawText, hexToRgb } from "./textDraw";

export type EmbeddedImageCache = Map<string, PDFImage>;

export async function drawOverlaysForPage(
  out: PDFPage,
  pageOverlays: Overlay[],
  fonts: FontSet,
  embeddedImages: EmbeddedImageCache,
  contentTextRedaction?: ContentTextRedaction,
): Promise<number> {
  let lostChars = 0;
  for (const o of pageOverlays) {
    if (o.type === "contentText") {
      lostChars += drawContentText(
        out,
        o,
        fonts,
        contentTextRedaction?.get(o.id),
      );
    }
  }
  for (const o of pageOverlays) {
    if (o.type === "contentText") continue;
    const turned = beginFreeRotation(out, o);
    if (o.type === "highlight") drawHighlight(out, o);
    else if (o.type === "underline") drawUnderline(out, o);
    else if (o.type === "strikethrough") drawStrikeOut(out, o);
    else if (o.type === "rect") drawRect(out, o);
    else if (o.type === "stamp") drawStamp(out, o);
    else if (o.type === "image") await drawImageOverlay(out, o, embeddedImages);
    else if (o.type === "ink") drawInk(out, o);
    else if (o.type === "note") lostChars += drawNote(out, o, fonts);
    else if (o.type === "text") lostChars += drawTextBox(out, o, fonts);
    else if (o.type === "callout") lostChars += drawCallout(out, o, fonts);
    if (turned) out.pushOperators(popGraphicsState());
  }
  return lostChars;
}

// Box overlays carry a free rotation: degrees clockwise as seen, about the
// rect center, on top of the page's /Rotate (OverlayDom's boxPlacement).
// PDF user space is y-up, so clockwise is the negative angle here. Original-
// text edits have no rotate handle and stay pinned to the glyphs they cover.
// Returns whether a graphics state was pushed and must be popped.
function beginFreeRotation(out: PDFPage, o: Overlay): boolean {
  if (
    o.type !== "rect" &&
    o.type !== "stamp" &&
    o.type !== "image" &&
    o.type !== "note" &&
    o.type !== "text"
  ) {
    return false;
  }
  const angle = o.angle ?? 0;
  if (!Number.isFinite(angle) || angle % 360 === 0) return false;
  const rad = (angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = o.rect.x + o.rect.w / 2;
  const cy = o.rect.y + o.rect.h / 2;
  out.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(
      cos,
      -sin,
      sin,
      cos,
      cx - cos * cx - sin * cy,
      cy + sin * cx - cos * cy,
    ),
  );
  return true;
}

export async function drawImageOverlaysForPage(
  out: PDFPage,
  pageOverlays: Overlay[],
  embeddedImages: EmbeddedImageCache,
): Promise<void> {
  for (const overlay of pageOverlays) {
    if (overlay.type === "image") {
      const turned = beginFreeRotation(out, overlay);
      await drawImageOverlay(out, overlay, embeddedImages);
      if (turned) out.pushOperators(popGraphicsState());
    }
  }
}

export function drawContentTextEditsForPage(
  out: PDFPage,
  pageOverlays: Overlay[],
  fonts: FontSet,
  contentTextRedaction?: ContentTextRedaction,
): number {
  let lostChars = 0;
  for (const overlay of pageOverlays) {
    if (overlay.type !== "contentText") continue;
    lostChars += drawContentText(
      out,
      overlay,
      fonts,
      contentTextRedaction?.get(overlay.id),
    );
  }
  return lostChars;
}

function drawHighlight(out: PDFPage, o: HighlightOverlay) {
  const color = hexToRgb(o.color);
  for (const r of o.rects) {
    out.drawRectangle({
      x: r.x,
      y: r.y,
      width: r.w,
      height: r.h,
      color,
      opacity: o.opacity,
      blendMode: BlendMode.Multiply,
      borderWidth: 0,
    });
  }
}

function drawCallout(
  out: PDFPage,
  o: CalloutOverlay,
  fonts: FontSet,
): number {
  const color = hexToRgb(o.color);
  for (const target of o.targetRects) {
    out.drawRectangle({
      x: target.x,
      y: target.y,
      width: target.w,
      height: target.h,
      color,
      opacity: CALLOUT_TARGET_OPACITY,
      blendMode: BlendMode.Multiply,
      borderWidth: 0,
    });
  }

  const connector = calloutConnectorGeometry(o);
  const c1 = {
    x: connector.from.x + (connector.control.x - connector.from.x) * (2 / 3),
    y: connector.from.y + (connector.control.y - connector.from.y) * (2 / 3),
  };
  const c2 = {
    x: connector.to.x + (connector.control.x - connector.to.x) * (2 / 3),
    y: connector.to.y + (connector.control.y - connector.to.y) * (2 / 3),
  };
  const leaderOperators =
    connector.kind === "polyline"
      ? [
          lineTo(connector.control.x, connector.control.y),
          lineTo(connector.to.x, connector.to.y),
        ]
      : [
          appendBezierCurve(
            c1.x,
            c1.y,
            c2.x,
            c2.y,
            connector.to.x,
            connector.to.y,
          ),
        ];
  out.pushOperators(
    pushGraphicsState(),
    setStrokingColor(color),
    setLineWidth(1.25),
    setLineCap(LineCapStyle.Round),
    setLineJoin(LineJoinStyle.Round),
    moveTo(connector.from.x, connector.from.y),
    ...leaderOperators,
    moveTo(connector.to.x, connector.to.y),
    lineTo(connector.arrowLeft.x, connector.arrowLeft.y),
    moveTo(connector.to.x, connector.to.y),
    lineTo(connector.arrowRight.x, connector.arrowRight.y),
    stroke(),
    popGraphicsState(),
  );
  out.drawRectangle({
    x: o.rect.x,
    y: o.rect.y,
    width: o.rect.w,
    height: o.rect.h,
    color: rgb(1, 0.992, 0.973),
    borderColor: color,
    borderWidth: 0.8,
  });
  out.pushOperators(
    pushGraphicsState(),
    rectangle(o.rect.x, o.rect.y, o.rect.w, o.rect.h),
    clip(),
    endPath(),
  );
  const lostChars = drawText(out, o, fonts);
  out.pushOperators(popGraphicsState());
  return lostChars;
}

function drawUnderline(out: PDFPage, o: UnderlineOverlay) {
  drawTextLineMarkup(out, o, underlinePdfY);
}

function drawStrikeOut(out: PDFPage, o: StrikeOutOverlay) {
  drawTextLineMarkup(out, o, strikethroughPdfY);
}

function drawTextLineMarkup(
  out: PDFPage,
  o: UnderlineOverlay | StrikeOutOverlay,
  lineY: (rect: { y: number; h: number }) => number,
) {
  const color = hexToRgb(o.color);
  const thickness = underlineStrokeWidth(o.rects);
  for (const r of o.rects) {
    const y = lineY(r);
    out.drawLine({
      start: { x: r.x, y },
      end: { x: r.x + r.w, y },
      thickness,
      color,
      opacity: o.opacity,
      lineCap: LineCapStyle.Round,
    });
  }
}

function underlineStrokeWidth(rects: Array<{ h: number }>): number {
  const minHeight = Math.min(...rects.map((r) => r.h).filter((h) => h > 0));
  if (!Number.isFinite(minHeight)) return 1;
  return Math.max(0.75, Math.min(2, minHeight * 0.08));
}

function underlinePdfY(rect: { y: number; h: number }): number {
  return rect.y + Math.max(0.75, Math.min(2, rect.h * 0.12));
}

function strikethroughPdfY(rect: { y: number; h: number }): number {
  return rect.y + rect.h * 0.45;
}

function drawRect(out: PDFPage, o: RectOverlay) {
  out.drawRectangle({
    x: o.rect.x,
    y: o.rect.y,
    width: o.rect.w,
    height: o.rect.h,
    borderColor: hexToRgb(o.color),
    borderWidth: o.strokeWidth,
    color: o.fill ? hexToRgb(o.fill) : undefined,
    opacity: o.fill ? (o.opacity ?? 1) : 0,
    borderOpacity: o.opacity,
  });
}

// A text box imported with a fill, a frame or a /CA draws them as its
// FreeText appearance does: the fill over the whole box, the frame inset by
// half its width, the text on top, all at that opacity. Others draw only text.
function drawTextBox(out: PDFPage, o: TextOverlay, fonts: FontSet): number {
  const border = o.borderWidth ?? 0;
  const alpha = typeof o.opacity === "number" && o.opacity < 1 ? Math.max(0, o.opacity) : undefined;
  if (!o.fill && border <= 0 && alpha === undefined) return drawText(out, o, fonts);
  out.pushOperators(pushGraphicsState());
  if (alpha !== undefined) {
    const gs = out.doc.context.obj({ Type: "ExtGState", ca: alpha, CA: alpha });
    out.pushOperators(setGraphicsState(out.node.newExtGState("GS", gs)));
  }
  const { x, y, w, h } = o.rect;
  if (o.fill) out.drawRectangle({ x, y, width: w, height: h, color: hexToRgb(o.fill) });
  if (border > 0) {
    out.drawRectangle({
      x: x + border / 2,
      y: y + border / 2,
      width: Math.max(0, w - border),
      height: Math.max(0, h - border),
      borderColor: hexToRgb(o.borderColor ?? o.color),
      borderWidth: border,
    });
  }
  const lost = drawText(out, o, fonts);
  out.pushOperators(popGraphicsState());
  return lost;
}

function drawStamp(out: PDFPage, o: StampOverlay) {
  const paths = stampPdfPaths(o);
  if (paths.length === 0) return;
  out.pushOperators(
    pushGraphicsState(),
    setStrokingColor(hexToRgb(o.color)),
    setLineWidth(o.strokeWidth),
    setLineCap(LineCapStyle.Round),
    setLineJoin(LineJoinStyle.Round),
  );
  for (const path of paths) {
    const [first, ...rest] = path;
    if (!first) continue;
    out.pushOperators(moveTo(first.x, first.y));
    for (const point of rest) {
      out.pushOperators(lineTo(point.x, point.y));
    }
  }
  out.pushOperators(stroke(), popGraphicsState());
}

function drawInk(out: PDFPage, o: InkOverlay) {
  const color = hexToRgb(o.color);
  out.pushOperators(pushGraphicsState());
  // An imported stroke's /CA (a highlighter pen); none for Shiori's own.
  if (o.opacity !== undefined && o.opacity < 1) {
    const ctx = out.doc.context;
    const gs = out.node.newExtGState("GS", ctx.obj({ Type: "ExtGState", CA: Math.max(0, o.opacity) }));
    out.pushOperators(setGraphicsState(gs));
  }
  out.pushOperators(
    setStrokingColor(color),
    setLineWidth(o.width),
    setLineCap(LineCapStyle.Round),
    setLineJoin(LineJoinStyle.Round),
  );
  for (const path of o.paths) {
    const [first, ...rest] = path;
    if (!first) continue;
    out.pushOperators(moveTo(first.x, first.y));
    if (rest.length === 0) {
      out.pushOperators(lineTo(first.x, first.y));
      continue;
    }
    for (const point of rest) {
      out.pushOperators(lineTo(point.x, point.y));
    }
  }
  out.pushOperators(stroke(), popGraphicsState());
}

async function drawImageOverlay(
  out: PDFPage,
  o: ImageOverlay,
  embeddedImages: EmbeddedImageCache,
) {
  const bytes = imageDataUrlBytes(o.dataUrl);
  if (!bytes) return;
  const cacheKey = `${o.mimeType}\0${o.dataUrl}`;
  let image = embeddedImages.get(cacheKey);
  if (!image) {
    image =
      o.mimeType === "image/jpeg"
        ? await out.doc.embedJpg(bytes)
        : await out.doc.embedPng(bytes);
    embeddedImages.set(cacheKey, image);
  }
  out.drawImage(image, {
    x: o.rect.x,
    y: o.rect.y,
    width: o.rect.w,
    height: o.rect.h,
  });
}

function drawNote(out: PDFPage, o: NoteOverlay, fonts: FontSet): number {
  const color = hexToRgb(o.color);
  out.drawRectangle({
    x: o.rect.x,
    y: o.rect.y,
    width: o.rect.w,
    height: o.rect.h,
    color,
    opacity: 0.6,
    borderColor: rgb(0.1, 0.1, 0.1),
    borderWidth: 0.5,
  });
  if (o.text) {
    const size = 10;
    return drawText(
      out,
      {
        type: "text",
        id: o.id,
        pageId: o.pageId,
        rect: {
          x: o.rect.x + 4,
          y: o.rect.y + 4,
          w: Math.max(1, o.rect.w - 8),
          h: Math.max(1, o.rect.h - 8),
        },
        text: o.text,
        fontSize: size,
        color: "#1a1815",
        bold: false,
        align: "left",
        fontFamily: "sans",
      },
      fonts,
    );
  }
  return 0;
}

function stampPdfPaths(o: StampOverlay): PdfPath[] {
  const { rect } = o;
  const pt = (rx: number, ry: number) => ({
    x: rect.x + rect.w * rx,
    y: rect.y + rect.h * ry,
  });
  if (o.kind === "cross") {
    return [
      [pt(0.18, 0.18), pt(0.82, 0.82)],
      [pt(0.82, 0.18), pt(0.18, 0.82)],
    ];
  }
  return [[pt(0.15, 0.52), pt(0.42, 0.28), pt(0.85, 0.76)]];
}

type PdfPath = Array<{ x: number; y: number }>;

function imageDataUrlBytes(dataUrl: string): Uint8Array | null {
  const match = /^data:image\/(?:png|jpe?g);base64,([a-z0-9+/=\s]+)$/i.exec(
    dataUrl,
  );
  if (!match) return null;
  const binary = globalThis.atob(match[1]!.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
