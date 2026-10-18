// Ink strokes are captured one point per pointermove event — on a stylus at
// 120–240 Hz that is hundreds of near-collinear points per stroke, and each
// point is a full-precision {x, y} pair. Left raw they dominate draft size
// (a heavily hand-annotated page can be megabytes per undo snapshot). These
// two pure passes run once, when a stroke is finalized into PDF user space,
// so every downstream consumer (render, export, draft, CLI extract) sees the
// reduced path. Both are deliberately conservative: the goal is to drop
// points the eye cannot resolve, never to reshape the stroke.

export type SimplePoint = { x: number; y: number };

// Ramer–Douglas–Peucker: keep only the points that carry the stroke's shape,
// dropping any that sit within `epsilon` of the line between their neighbours.
// Epsilon is in PDF points (1/72 inch); ~0.4pt ≈ 0.14mm is below what a reader
// can distinguish, yet removes the dense collinear runs a fast stroke leaves.
export function simplifyPathRDP(
  points: readonly SimplePoint[],
  epsilon: number,
): SimplePoint[] {
  if (points.length <= 2 || epsilon <= 0) {
    return points.map((p) => ({ x: p.x, y: p.y }));
  }

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  // Iterative RDP with an explicit stack: recursion could blow the call stack
  // on a stroke with thousands of points.
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    let maxDist = -1;
    let maxIndex = -1;
    for (let i = start + 1; i < end; i += 1) {
      const dist = perpendicularDistance(points[i]!, points[start]!, points[end]!);
      if (dist > maxDist) {
        maxDist = dist;
        maxIndex = i;
      }
    }
    if (maxDist > epsilon && maxIndex !== -1) {
      keep[maxIndex] = 1;
      stack.push([start, maxIndex], [maxIndex, end]);
    }
  }

  const result: SimplePoint[] = [];
  for (let i = 0; i < points.length; i += 1) {
    if (keep[i]) result.push({ x: points[i]!.x, y: points[i]!.y });
  }
  return result;
}

// Distance from `p` to the segment a→b. When a and b coincide the segment is a
// point, so fall back to the plain point distance.
function perpendicularDistance(
  p: SimplePoint,
  a: SimplePoint,
  b: SimplePoint,
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  // Project p onto the infinite line, clamp to the segment, measure the gap.
  const t = Math.max(
    0,
    Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq),
  );
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  return Math.hypot(p.x - projX, p.y - projY);
}

// Round each coordinate to `decimals` places, trimming the float64 long tail
// (640.4000000000001 → 640.4). Sub-0.01pt precision is meaningless for a
// hand-drawn stroke and only bloats the serialized JSON that draft accounting
// measures.
export function quantizePath(
  points: readonly SimplePoint[],
  decimals = 2,
): SimplePoint[] {
  const factor = 10 ** decimals;
  return points.map((p) => ({
    x: Math.round(p.x * factor) / factor,
    y: Math.round(p.y * factor) / factor,
  }));
}

// The default an ink stroke is finalized with: simplify away sub-perceptual
// points, then quantize what remains.
export const INK_SIMPLIFY_EPSILON_PT = 0.4;

export function compactInkPath(points: readonly SimplePoint[]): SimplePoint[] {
  return quantizePath(simplifyPathRDP(points, INK_SIMPLIFY_EPSILON_PT));
}
