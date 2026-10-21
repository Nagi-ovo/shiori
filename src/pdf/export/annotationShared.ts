// Small value helpers shared by the annotation builders: colours, rects,
// numbers, dates, and the NM / Shio entries every Shiori annotation carries.
// Split out of ./annotations.

import {
  PDFDict,
  PDFHexString,
  PDFName,
  PDFString,
  type PDFPage,
} from "pdf-lib";
import type { OverlayTextAnchor } from "../model/types";

export const SHIORI_ANNOT_PREFIX = "shiori:";

// PDF date syntax: D:YYYYMMDDHHmmSSZ. Always emitted in UTC so the value does
// not depend on the exporting machine's time zone.
export function formatPdfDate(epochMs: number): string | null {
  if (!Number.isFinite(epochMs)) return null;
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return (
    `D:${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}` +
    `${pad(date.getUTCDate())}${pad(date.getUTCHours())}` +
    `${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

export function hexToRgbArr(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h.length === 6
        ? h
        : "000000";
  return [
    parseInt(full.slice(0, 2), 16) / 255,
    parseInt(full.slice(2, 4), 16) / 255,
    parseInt(full.slice(4, 6), 16) / 255,
  ];
}

export function unionRects(
  rects: { x: number; y: number; w: number; h: number }[],
): { x: number; y: number; w: number; h: number } {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const r of rects) {
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.w > maxX) maxX = r.x + r.w;
    if (r.y + r.h > maxY) maxY = r.y + r.h;
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function fmt(n: number): string {
  // Trim to 4 decimals — full float precision bloats the PDF and most
  // viewers truncate anyway. Also strips trailing zeros.
  return Number(n.toFixed(4)).toString();
}

export function shioriAnnotationName(id: string): PDFString {
  return PDFString.of(`${SHIORI_ANNOT_PREFIX}${id}`);
}

// Anchor provenance rides in Shiori's versioned developer dictionary: for a
// callout it joins the Shio dict buildCallout already writes; markups and
// sticky notes get a minimal `Shio: { V: 1, Anchor: {...} }`. Standard
// viewers ignore unknown developer dictionaries, so appearance is untouched.
export function setShioAnchor(
  page: PDFPage,
  dict: PDFDict,
  o: { anchor?: OverlayTextAnchor },
): void {
  const anchor = o.anchor;
  if (!anchor) return;
  const ctx = page.doc.context;
  const existing = dict.lookupMaybe(PDFName.of("Shio"), PDFDict);
  const shio = existing ?? (ctx.obj({ V: 1 }) as PDFDict);
  shio.set(
    PDFName.of("Anchor"),
    ctx.obj({
      Q: PDFHexString.fromText(anchor.quote),
      Pg: anchor.page,
      // Optional: in-app selection capture records no occurrence.
      ...(anchor.occurrence !== undefined ? { Occ: anchor.occurrence } : {}),
    }),
  );
  if (!existing) dict.set(PDFName.of("Shio"), shio);
}

export function decodePdfText(value: PDFString | PDFHexString | undefined): string {
  try {
    return value?.decodeText() ?? "";
  } catch {
    return "";
  }
}

export type FreeRotation = {
  /** /Rect: the axis-aligned bounds of the turned box. */
  rect: [number, number, number, number];
  /** The appearance /Matrix over BBox [0 0 w h]: the turn about its centre. */
  matrix: [number, number, number, number, number, number];
  /** The FreeText /Rotate for a quarter turn: the content's own counter-clockwise turn. */
  rotate?: 90 | 180 | 270;
};

// An overlay's free rotation (degrees clockwise as seen, about the rect
// centre) for an annotation that has none of its own. A viewer fits the
// appearance's turned BBox into /Rect, so the turn lives in the /Matrix and
// /Rect grows to hold the turned box. Clockwise is the negative angle in
// PDF's y-up space, as in the flattened draw (./overlayDraw). Null when the
// box is not turned, so its annotation is written exactly as before.
export function freeRotation(
  rect: { x: number; y: number; w: number; h: number },
  angle: number | undefined,
): FreeRotation | null {
  const turn = (((angle ?? 0) % 360) + 360) % 360;
  if (!Number.isFinite(turn) || turn === 0) return null;
  const snap = (n: number) => Number(n.toFixed(10)) || 0;
  const rad = (turn * Math.PI) / 180;
  const cos = snap(Math.cos(rad));
  const sin = snap(Math.sin(rad));
  const cx = rect.w / 2;
  const cy = rect.h / 2;
  const w = Math.abs(rect.w * cos) + Math.abs(rect.h * sin);
  const h = Math.abs(rect.w * sin) + Math.abs(rect.h * cos);
  const px = rect.x + cx;
  const py = rect.y + cy;
  const rotate = turn === 90 ? 270 : turn === 180 ? 180 : turn === 270 ? 90 : undefined;
  return {
    rect: [px - w / 2, py - h / 2, px + w / 2, py + h / 2],
    matrix: [cos, -sin, sin, cos, snap(cx - cos * cx - sin * cy), snap(cy + sin * cx - cos * cy)],
    ...(rotate ? { rotate } : {}),
  };
}
