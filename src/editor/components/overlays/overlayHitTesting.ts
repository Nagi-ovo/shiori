import { pdfRectToDisplay, pdfToDisplay } from "../../../pdf/geometry/coords";
import type { Overlay, PageModel, PdfRect } from "../../../pdf/model/types";
import { calloutConnectorGeometry } from "../../../pdf/model/callout";
import { boundsOf } from "../../overlays/geometry";
import { isTextMarkupOverlay } from "./overlayGuards";

// Marquee hit-test. Figma-style semantics: an overlay is selected if
// its bounding box intersects the marquee, not just when fully contained.
export function overlayHitsMarquee(
  overlay: Overlay,
  marquee: { x: number; y: number; w: number; h: number },
  page: PageModel,
  scale: number,
  // Presentation-only: a collapsed callout is a small seal, so the marquee
  // must test the seal and its longer leader, not the label box it hides.
  collapsedRect: PdfRect | null = null,
): boolean {
  if (overlay.type === "callout") {
    const labelRect = collapsedRect ?? overlay.rect;
    const label = pdfRectToDisplay(
      labelRect,
      page.widthPt,
      page.heightPt,
      page.rotation,
      scale,
    );
    if (rectsIntersect(label, marquee)) return true;
    if (
      overlay.targetRects.some((rect) =>
        rectsIntersect(
          pdfRectToDisplay(
            rect,
            page.widthPt,
            page.heightPt,
            page.rotation,
            scale,
          ),
          marquee,
        ),
      )
    ) {
      return true;
    }
    const connector = calloutConnectorGeometry(
      collapsedRect ? { ...overlay, rect: collapsedRect } : overlay,
    );
    const bounds = boundsOf([
      connector.from,
      connector.control,
      connector.to,
      connector.arrowLeft,
      connector.arrowRight,
    ]);
    return rectsIntersect(
      pdfRectToDisplay(
        bounds,
        page.widthPt,
        page.heightPt,
        page.rotation,
        scale,
      ),
      marquee,
    );
  }
  if (
    overlay.type === "rect" ||
    overlay.type === "image" ||
    overlay.type === "stamp" ||
    overlay.type === "note" ||
    overlay.type === "text" ||
    overlay.type === "contentText"
  ) {
    const angle = "angle" in overlay ? overlay.angle ?? 0 : 0;
    if (angle !== 0) {
      // For a freely-rotated box, test the rotated box's AABB. (For 90°
      // multiples the page rotation alone is already an axis-aligned box,
      // which pdfRectToDisplay handles below; the free angle is what makes
      // the on-screen box non-axis-aligned.)
      const d = rotatedBoxAabb(overlay.rect, angle, page, scale);
      return rectsIntersect(d, marquee);
    }
    const d = pdfRectToDisplay(
      overlay.rect,
      page.widthPt,
      page.heightPt,
      page.rotation,
      scale,
    );
    return rectsIntersect(d, marquee);
  }
  if (isTextMarkupOverlay(overlay)) {
    return overlay.rects.some((rect) => {
      const d = pdfRectToDisplay(
        rect,
        page.widthPt,
        page.heightPt,
        page.rotation,
        scale,
      );
      return rectsIntersect(d, marquee);
    });
  }
  if (overlay.type === "ink") {
    const flat = overlay.paths.flat();
    if (flat.length === 0) return false;
    const bounds = boundsOf(flat);
    const d = pdfRectToDisplay(
      bounds,
      page.widthPt,
      page.heightPt,
      page.rotation,
      scale,
    );
    return rectsIntersect(d, marquee);
  }
  return false;
}

// Display-space AABB of a box rotated about its center by the total angle
// (page rotation + element free angle). Matches the center-anchored render
// in OverlayDom/overlaySvg: the 4 corners of the natural-size box are spun
// about the (rotation-invariant) display center, then bounded.
function rotatedBoxAabb(
  rect: PdfRect,
  angle: number,
  page: PageModel,
  scale: number,
): { x: number; y: number; w: number; h: number } {
  const totalDeg = page.rotation + angle;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const c = pdfToDisplay(
    { x: cx, y: cy },
    page.widthPt,
    page.heightPt,
    page.rotation,
    scale,
  );
  const w = rect.w * scale;
  const h = rect.h * scale;
  const rad = (totalDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const halfW = w / 2;
  const halfH = h / 2;
  const offsets = [
    { x: -halfW, y: -halfH },
    { x: halfW, y: -halfH },
    { x: halfW, y: halfH },
    { x: -halfW, y: halfH },
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const o of offsets) {
    const px = c.x + o.x * cos - o.y * sin;
    const py = c.y + o.x * sin + o.y * cos;
    minX = Math.min(minX, px);
    minY = Math.min(minY, py);
    maxX = Math.max(maxX, px);
    maxY = Math.max(maxY, py);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function rectsIntersect(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return !(
    a.x + a.w < b.x ||
    b.x + b.w < a.x ||
    a.y + a.h < b.y ||
    b.y + b.h < a.y
  );
}
