// An ink stroke's SVG: its paths, the live-reveal stroke draw, and the
// selection box. Split out of ./overlaySvg.

import { T } from "../../../design/tokens";
import type { Overlay, PageModel } from "../../../pdf/model/types";
import { pdfRectToDisplay, pdfToDisplay } from "../../../pdf/geometry/coords";
import { boundsOf } from "../../overlays/geometry";
import {
  fitLiveRevealPartTiming,
  liveRevealAnimationDelay,
  type ActiveLiveOverlayReveal,
} from "../../../live/overlayReveal";

export function renderInkSvg(
  overlay: Extract<Overlay, { type: "ink" }>,
  page: PageModel,
  scale: number,
  selected: boolean,
  reveal: ActiveLiveOverlayReveal | null,
) {
  let selBox: { x: number; y: number; w: number; h: number } | null = null;
  if (selected) {
    const flat = overlay.paths.flat();
    if (flat.length > 0) {
      const bounds = boundsOf(flat);
      const d = pdfRectToDisplay(
        bounds,
        page.widthPt,
        page.heightPt,
        page.rotation,
        scale,
      );
      const pad = Math.max(4, overlay.width);
      selBox = {
        x: d.x - pad,
        y: d.y - pad,
        w: d.w + pad * 2,
        h: d.h + pad * 2,
      };
    }
  }
  return (
    <g key={overlay.id}>
      {overlay.paths.map((pts, i) => {
        const d = pts.map((p) =>
          pdfToDisplay(p, page.widthPt, page.heightPt, page.rotation, scale),
        );
        if (d.length < 2) return null;
        const path = d
          .map((pt, j) => `${j === 0 ? "M" : "L"}${pt.x},${pt.y}`)
          .join(" ");
        const timing = reveal
          ? fitLiveRevealPartTiming(
              reveal.item.durationMs,
              overlay.paths.length,
              48,
            )
          : null;
        return (
          <path
            key={i}
            d={path}
            fill="none"
            stroke={overlay.color}
            strokeWidth={overlay.width}
            strokeLinecap="round"
            strokeLinejoin="round"
            pathLength={reveal ? 1 : undefined}
            strokeDasharray={reveal ? 1 : undefined}
            strokeDashoffset={reveal ? 1 : undefined}
            data-live-reveal={reveal ? "ink" : undefined}
            style={reveal ? {
              animation: `shioriLiveStrokeDraw ${timing!.partDurationMs}ms cubic-bezier(.22,.8,.24,1) ${liveRevealAnimationDelay(reveal, i * timing!.staggerMs)} both`,
            } : undefined}
          />
        );
      })}
      {selBox ? (
        <rect
          x={selBox.x}
          y={selBox.y}
          width={selBox.w}
          height={selBox.h}
          fill="none"
          stroke={T.ink}
          strokeWidth={1}
          strokeDasharray="4 3"
          rx={2}
          ry={2}
        />
      ) : null}
    </g>
  );
}
