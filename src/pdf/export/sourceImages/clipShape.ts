import type { PdfPoint, PdfRect } from "../../model/types";
import type { ContentOp } from "../contentStreamEdit/tokenizer";
import type { SourceImageMatrix } from "./content";

type ClipShape = { box: PdfRect } | { points: PdfPoint[] };
export type ImageClip = ClipShape & { matrix: SourceImageMatrix };

export function shapeCorners(shape: ClipShape): PdfPoint[] {
  if ("points" in shape) return shape.points;
  const { x, y, w, h } = shape.box;
  if (!(x + w > x && y + h > y) || ![x, y, x + w, y + h].every(Number.isFinite)) return [];
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

export function projectImagePoint([a, b, c, d, e, f]: SourceImageMatrix, { x, y }: PdfPoint): PdfPoint {
  return { x: a * x + c * y + e, y: b * x + d * y + f };
}

export function clipEdgeDistances(points: PdfPoint[], orientation = 1) {
  return points.map((a, i) => {
    const b = points[(i + 1) % points.length]!;
    const dx = b.x - a.x, dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    const u = orientation * dx / length, v = orientation * dy / length;
    return (p: PdfPoint) => u * (p.y - a.y) - v * (p.x - a.x);
  });
}

/** Accept a single rectangle or straight, strictly convex subpath. Every
 * other path stays opaque, including compound paths under either fill rule. */
export function simpleClipShape(ops: ContentOp[], start: number, end: number): ClipShape | undefined {
  const first = ops[start];
  if (end === start + 1 && first?.operator === "re") {
    const [x, y, w, h] = numericOperands(first, 4) ?? [];
    if (x === undefined || y === undefined || w === undefined || h === undefined) return;
    return { box: { x: Math.min(x, x + w), y: Math.min(y, y + h), w: Math.abs(w), h: Math.abs(h) } };
  }

  if (first?.operator !== "m") return;
  const last = ops[end - 1];
  if (last?.operator === "h" && !last.operands.length) end -= 1;
  const size = end - start;
  // Bound the proof cost for paths that approximate curves with line segments.
  if (size < 3 || size > 16) return;
  const points: PdfPoint[] = [];
  for (let i = start; i < end; i += 1) {
    const op = ops[i]!;
    if (i > start && op.operator !== "l") return;
    const position = numericOperands(op, 2);
    if (!position) return;
    points.push({ x: position[0]!, y: position[1]! });
  }
  const edges = clipEdgeDistances(points);
  const sign = Math.sign(edges[0]!(points[2]!));
  if (!sign || !edges.every((distance, i) => points.every((point, j) =>
    j === i || j === (i + 1) % size || Math.sign(distance(point)) === sign))) return;
  if (sign < 0) points.reverse();
  return { points };
}

function numericOperands(op: ContentOp, count: number): number[] | undefined {
  const { operands } = op;
  if (operands.length !== count || !operands.every(o => o.kind === "number")) return;
  const numbers = operands.map(o => o.value);
  return numbers.every(Number.isFinite) ? numbers : undefined;
}
