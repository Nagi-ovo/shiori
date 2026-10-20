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
