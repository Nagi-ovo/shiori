// The frame, background and text colour of a text box, callout or original-
// text edit on the page. Split out of ./OverlayDom.

import { T } from "../../../design/tokens";
import type {
  CalloutOverlay,
  ContentTextOverlay,
  TextOverlay,
} from "../../../pdf/model/types";

export function textBoxSurface(
  overlay: TextOverlay | ContentTextOverlay | CalloutOverlay,
  { selected, collapsed, scale }: { selected: boolean; collapsed: boolean; scale: number },
): { border: string; backgroundColor: string; color: string } {
  const isCallout = overlay.type === "callout";
  if (overlay.type === "text" && (overlay.fill || (overlay.borderWidth ?? 0) > 0)) {
    return importedBoxSurface(overlay, selected, scale);
  }
  // contentText and callouts frame with `outline` (see ./OverlayDom).
  const border = overlay.type === "contentText" || isCallout
    ? "none"
    : `1px dashed ${selected ? T.ink : "rgba(26,24,21,0.18)"}`;
  const backgroundColor = isCallout
    ? collapsed
      ? overlay.color
      : "rgba(255,253,247,0.96)"
    : selected
      ? "rgba(26,24,21,0.02)"
      : "transparent";
  return { border, backgroundColor, color: withAlpha(overlay.color, textOpacity(overlay)) };
}

// A box imported with its own fill or frame draws them, as the exported
// FreeText does, in place of Shiori's dashed guide; selection still shows by
// its handles. Its /CA applies to each of fill, frame and text, as a PDF
// viewer paints them one over another.
function importedBoxSurface(overlay: TextOverlay, selected: boolean, scale: number) {
  const alpha = textOpacity(overlay);
  const width = overlay.borderWidth ?? 0;
  return {
    border: width > 0
      ? `${width * scale}px solid ${withAlpha(overlay.borderColor ?? overlay.color, alpha)}`
      : `1px dashed ${selected ? T.ink : "rgba(26,24,21,0.18)"}`,
    backgroundColor: overlay.fill ? withAlpha(overlay.fill, alpha) : "transparent",
    color: withAlpha(overlay.color, alpha),
  };
}

function textOpacity(overlay: TextOverlay | ContentTextOverlay | CalloutOverlay): number | undefined {
  if (overlay.type !== "text" || typeof overlay.opacity !== "number") return undefined;
  return Number.isFinite(overlay.opacity) ? Math.min(1, Math.max(0, overlay.opacity)) : undefined;
}

/** `#rrggbb` as rgba at `alpha`; left as it is when there is no alpha or it is not hex. */
function withAlpha(hex: string, alpha: number | undefined): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match || alpha === undefined) return hex;
  const value = parseInt(match[1]!, 16);
  return `rgba(${value >> 16}, ${(value >> 8) & 255}, ${value & 255}, ${alpha ?? 1})`;
}
