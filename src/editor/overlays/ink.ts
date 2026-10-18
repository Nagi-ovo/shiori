type Point = { x: number; y: number };

export function constrainInkPoint(start: Point, current: Point): Point {
  const dx = current.x - start.x;
  const dy = current.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return current;

  const step = Math.PI / 4;
  const snappedAngle = Math.round(Math.atan2(dy, dx) / step) * step;
  return {
    x: start.x + Math.cos(snappedAngle) * length,
    y: start.y + Math.sin(snappedAngle) * length,
  };
}
