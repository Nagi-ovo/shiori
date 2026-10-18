import type { Overlay, PdfPoint, PdfRect, Rotation } from "../../pdf/model/types";

export type ResizeCorner = "nw" | "ne" | "sw" | "se";

export function cloneOverlay(o: Overlay): Overlay {
  if (
    o.type === "highlight" ||
    o.type === "underline" ||
    o.type === "strikethrough"
  ) {
    return { ...o, rects: o.rects.map((r) => ({ ...r })) };
  }
  if (o.type === "ink") {
    return {
      ...o,
      paths: o.paths.map((path) => path.map((p) => ({ ...p }))),
    };
  }
  if (o.type === "contentText") {
    return {
      ...o,
      rect: { ...o.rect },
      coverRects: o.coverRects.map((r) => ({ ...r })),
    };
  }
  if (o.type === "callout") {
    return {
      ...o,
      rect: { ...o.rect },
      targetRects: o.targetRects.map((rect) => ({ ...rect })),
      leader: o.leader?.map((point) => ({ ...point })),
      thread: o.thread?.map((entry) => ({ ...entry })),
    };
  }
  return { ...o, rect: { ...o.rect } };
}

export function cloneOverlayWithId(o: Overlay, id: string): Overlay {
  const copy = { ...cloneOverlay(o), id } as Overlay;
  // Every caller mints a NEW annotation (paste, duplicate, alt-drag). The
  // replica is offset or lands on another page, so inherited text-anchor
  // provenance would claim a location the copy does not sit on. Drop it;
  // plain cloneOverlay (drag baselines of the SAME overlay) keeps it.
  delete copy.anchor;
  // Same reasoning for where it came from: a copy the reader just made in
  // Shiori did not come out of the source document, whatever it was copied
  // from. Keeping these made a fresh copy claim the original's author and
  // dates — it would export attributed to a stranger, and read as old
  // imported content when the Live digest decides what to keep.
  delete copy.origin;
  delete copy.importedAt;
  delete copy.sourceAuthor;
  delete copy.sourceCreatedAt;
  delete copy.sourceModifiedAt;
  // The reply link points at an annotation this copy is not a reply to.
  delete copy.sourceInReplyToId;
  delete copy.sourceReplyType;
  return copy;
}

export function translateOverlay(
  o: Overlay,
  dx: number,
  dy: number,
): Partial<Overlay> {
  if (
    o.type === "highlight" ||
    o.type === "underline" ||
    o.type === "strikethrough"
  ) {
    return {
      rects: o.rects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy })),
    } as Partial<Overlay>;
  }
  if (o.type === "ink") {
    return {
      paths: o.paths.map((path) =>
        path.map((p) => ({ x: p.x + dx, y: p.y + dy })),
      ),
    } as Partial<Overlay>;
  }
  if (o.type === "contentText") {
    return {
      rect: {
        x: o.rect.x + dx,
        y: o.rect.y + dy,
        w: o.rect.w,
        h: o.rect.h,
      },
      coverRects: o.coverRects.map((r) => ({
        ...r,
        x: r.x + dx,
        y: r.y + dy,
      })),
      // sourceBaselinesPt is ABSOLUTE page-space (the render and the export
      // both draw at baselines[i] directly, ignoring rect.y) — translating
      // the covers without it desyncs text from redaction. Every user
      // gesture excludes contentText (move guard, nudge, duplicate,
      // clipboard), so this is belt-and-braces for future callers,
      // mirroring pageSpace.ts's translate.
      ...(o.sourceBaselinesPt
        ? { sourceBaselinesPt: o.sourceBaselinesPt.map((y) => y + dy) }
        : {}),
    } as Partial<Overlay>;
  }
  if (o.type === "callout") {
    // A normal drag repositions the label while its semantic target remains
    // attached to the source text. Clipboard duplication translates both via
    // translateCalloutWithTarget() below.
    return {
      rect: {
        x: o.rect.x + dx,
        y: o.rect.y + dy,
        w: o.rect.w,
        h: o.rect.h,
      },
      leader: undefined,
    } as Partial<Overlay>;
  }
  return {
    rect: {
      x: o.rect.x + dx,
      y: o.rect.y + dy,
      w: o.rect.w,
      h: o.rect.h,
    },
  } as Partial<Overlay>;
}

export function translateCalloutWithTarget(
  o: Extract<Overlay, { type: "callout" }>,
  dx: number,
  dy: number,
): Partial<Overlay> {
  return {
    rect: { ...o.rect, x: o.rect.x + dx, y: o.rect.y + dy },
    targetRects: o.targetRects.map((rect) => ({
      ...rect,
      x: rect.x + dx,
      y: rect.y + dy,
    })),
    leader: o.leader?.map((point) => ({ x: point.x + dx, y: point.y + dy })),
  } as Partial<Overlay>;
}

export function resizeOverlayGeometry(
  o: Overlay,
  rect: PdfRect,
): Partial<Overlay> {
  if (o.type === "ink") {
    const points = o.paths.flat();
    if (points.length === 0) return {};
    const start = boundsOf(points);
    const sx = start.w === 0 ? 1 : rect.w / start.w;
    const sy = start.h === 0 ? 1 : rect.h / start.h;
    return {
      paths: o.paths.map((path) =>
        path.map((p) => ({
          x: rect.x + (p.x - start.x) * sx,
          y: rect.y + (p.y - start.y) * sy,
        })),
      ),
      width: Math.max(0.75, o.width * Math.min(Math.abs(sx), Math.abs(sy))),
    } as Partial<Overlay>;
  }

  if (o.type === "callout") {
    return { rect, leader: undefined } as Partial<Overlay>;
  }

  if (o.type !== "contentText") {
    return { rect } as Partial<Overlay>;
  }

  const sx = o.rect.w === 0 ? 1 : rect.w / o.rect.w;
  const sy = o.rect.h === 0 ? 1 : rect.h / o.rect.h;
  return {
    rect,
    coverRects: o.coverRects.map((r) => ({
      x: rect.x + (r.x - o.rect.x) * sx,
      y: rect.y + (r.y - o.rect.y) * sy,
      w: Math.max(0.5, r.w * sx),
      h: Math.max(0.5, r.h * sy),
    })),
  } as Partial<Overlay>;
}

// Standard 2D rotation of a vector by `deg` degrees clockwise in a
// y-down (display/client) coordinate frame. Used to un-spin a resize
// drag delta by the element's free-rotation angle before feeding it into
// the page-rotation pipeline. rotateVec(v, 0) is the identity, so
// non-rotated elements are unaffected.
export function rotateVec(
  dx: number,
  dy: number,
  deg: number,
): PdfPoint {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // In a y-down frame, a clockwise rotation by +deg maps
  //   x' = x·cos − y·sin
  //   y' = x·sin + y·cos
  return {
    x: dx * cos - dy * sin,
    y: dx * sin + dy * cos,
  };
}

// The linear (translation-free) part of coords.ts `displayToPdf`: it turns a
// display-space drag delta back into a PDF-space delta. It MUST stay in step
// with that function — differentiating displayToPdf gives exactly these four
// cases. When the 90/270 branches were swapped there, they were swapped here
// too, which is why the pair stayed self-consistent and dragging still felt
// right on a rotated page even though the stored coordinates were mirrored.
export function rotateDelta(
  dxDisplay: number,
  dyDisplay: number,
  rotation: Rotation,
): PdfPoint {
  switch (rotation) {
    case 0:
      return { x: dxDisplay, y: -dyDisplay };
    case 90:
      return { x: dyDisplay, y: dxDisplay };
    case 180:
      return { x: -dxDisplay, y: dyDisplay };
    case 270:
      return { x: -dyDisplay, y: -dxDisplay };
  }
}

export function adjustRect(
  start: PdfRect,
  corner: ResizeCorner,
  dPdf: PdfPoint,
  rotation: Rotation,
): PdfRect {
  let { x, y, w, h } = start;
  const dx = dPdf.x;
  const dy = dPdf.y;
  const which = remapCorner(corner, rotation);
  switch (which) {
    case "nw":
      x = start.x + dx;
      w = start.w - dx;
      h = start.h + dy;
      break;
    case "ne":
      w = start.w + dx;
      h = start.h + dy;
      break;
    case "sw":
      x = start.x + dx;
      w = start.w - dx;
      y = start.y + dy;
      h = start.h - dy;
      break;
    case "se":
      w = start.w + dx;
      y = start.y + dy;
      h = start.h - dy;
      break;
  }
  if (w < 4) w = 4;
  if (h < 4) h = 4;
  return { x, y, w, h };
}

export function remapCorner(
  corner: ResizeCorner,
  rotation: Rotation,
): ResizeCorner {
  const order: ResizeCorner[] = ["nw", "ne", "se", "sw"];
  const idx = order.indexOf(corner);
  const steps = rotation / 90;
  return order[(idx + steps) % 4]!;
}

export function boundsOf(points: Array<{ x: number; y: number }>): PdfRect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return {
    x: minX,
    y: minY,
    w: Math.max(1, maxX - minX),
    h: Math.max(1, maxY - minY),
  };
}
