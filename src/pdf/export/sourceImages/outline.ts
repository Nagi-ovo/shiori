import type { PdfPoint } from "../../model/types";
import type { SourceImageMatrix } from "./content";
import { clipEdgeDistances, projectImagePoint as mapPoint, shapeCorners, type ImageClip } from "./clipShape";

export function inverse([a, b, c, d, e, f]: SourceImageMatrix): SourceImageMatrix {
  const det = a * d - b * c;
  if (!Number.isFinite(det) || det === 0) throw Error("singular image transform");
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export function clipOutline(points: PdfPoint[], clip: ImageClip): PdfPoint[] {
  const vertices = shapeCorners(clip);
  if (vertices.length === 0) return [];
  const toClip = inverse(clip.matrix);
  let polygon = points.map(point => mapPoint(toClip, point));
  const edges = clipEdgeDistances(vertices);
  for (const distance of edges) {
    const clipped: PdfPoint[] = [];
    for (let i = 0; i < polygon.length; i += 1) {
      const a = polygon[(i + polygon.length - 1) % polygon.length]!;
      const b = polygon[i]!;
      const da = distance(a), db = distance(b);
      if ((da < 0) !== (db < 0)) {
        const ratio = da / (da - db);
        clipped.push({ x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio });
      }
      if (db >= 0) clipped.push(b);
    }
    polygon = clipped;
  }
  return polygon.map(point => mapPoint(clip.matrix, point));
}

export const identity: SourceImageMatrix = [1, 0, 0, 1, 0, 0];

export function outlineArea(outline: PdfPoint[]): number {
  const first = outline[0];
  if (!first) return 0;
  return Math.abs(outline.reduce((sum, point, i) => {
    const next = outline[(i + 1) % outline.length]!;
    return sum + (point.x - first.x) * (next.y - first.y) - (point.y - first.y) * (next.x - first.x);
  }, 0)) / 2;
}
