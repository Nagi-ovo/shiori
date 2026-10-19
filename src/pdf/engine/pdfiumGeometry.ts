import type { Rotation } from "../model/types";
import type { PdfPageGeometry } from "./types";

/** A page's box as shiori-core reports it, in every binding. */
export type PdfiumPageGeometry = {
  /** Clockwise degrees: 0, 90, 180 or 270. */
  rotation: number;
  originX: number;
  originY: number;
  width: number;
  height: number;
};

const ROTATIONS = new Set([0, 90, 180, 270]);

/** The core's page box as the reading layer models it. */
export function pageGeometryFromPdfium(geometry: PdfiumPageGeometry): PdfPageGeometry {
  return {
    rotation: (ROTATIONS.has(geometry.rotation) ? geometry.rotation : 0) as Rotation,
    originXPt: geometry.originX,
    originYPt: geometry.originY,
    widthPt: geometry.width,
    heightPt: geometry.height,
  };
}
