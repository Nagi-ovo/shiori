import type { StampOverlay } from "../../../pdf/model/types";

export function StampMark({
  kind,
  rect,
  color,
  strokeWidth,
}: {
  kind: StampOverlay["kind"];
  rect: { x: number; y: number; w: number; h: number };
  color: string;
  strokeWidth: number;
}) {
  const path = stampPath(rect, kind);
  return (
    <path
      d={path}
      fill="none"
      stroke={color}
      strokeWidth={Math.max(0.75, strokeWidth)}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
}

function stampPath(
  rect: { x: number; y: number; w: number; h: number },
  kind: StampOverlay["kind"],
): string {
  const pt = (rx: number, ryPdf: number) => ({
    x: rect.x + rect.w * rx,
    y: rect.y + rect.h * (1 - ryPdf),
  });
  if (kind === "cross") {
    const a = pt(0.18, 0.18);
    const b = pt(0.82, 0.82);
    const c = pt(0.82, 0.18);
    const d = pt(0.18, 0.82);
    return `M${a.x},${a.y}L${b.x},${b.y}M${c.x},${c.y}L${d.x},${d.y}`;
  }
  const a = pt(0.15, 0.52);
  const b = pt(0.42, 0.28);
  const c = pt(0.85, 0.76);
  return `M${a.x},${a.y}L${b.x},${b.y}L${c.x},${c.y}`;
}
