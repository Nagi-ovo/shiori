// The active tab's silhouette as SVG path data: rounded top corners, straight
// sides, and a concave fillet ("foot") at each bottom corner that curves out
// into the strip's baseline.
//
// Technique after chrome-tabs by Adam Schwartz
// (https://github.com/adamschwartz/chrome-tabs, MIT License; see
// THIRD_PARTY_NOTICES.md): the tab's outline and its feet are one vector path
// drawn with a fill and a stroke, so the browser antialiases a single shape.
// chrome-tabs draws a fixed 214×36 silhouette in two mirrored halves; Shiori
// keeps its own proportions (7px top radius, 7px feet) and draws the whole
// outline as one path at the tab's actual width, because two halves meet in
// a seam that shows in a 1px stroke at fractional devicePixelRatio values.
//
// The CSS it replaces drew the feet as radial-gradient hairlines beside a 1px
// box border. At Android WebView ratios such as 2.625 the gradient stops, the
// border and the baseline each rounded to device pixels on their own, which
// left jagged arcs and a misaligned join.
//
// Coordinates are CSS pixels in a box that spans the tab plus one foot on
// each side and the tab's full height. Every 1px edge is drawn on its
// half-pixel centre: the sides on the tab's outer columns, the top on its
// first row, and the feet ending on the box's last row, which is the row the
// strip paints its baseline on.

export type TabOutlinePaths = {
  /** Closed: the tab body plus the feet, down to the box's bottom edge. */
  fill: string;
  /** Open: foot, side, top, side, foot. No line across the bottom. */
  stroke: string;
};

const EMPTY: TabOutlinePaths = { fill: "", stroke: "" };

function n(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/**
 * @param width  the box's width: tab width + 2 × `foot`
 * @param height the tab's height
 * @param radius outer radius of the top corners
 * @param foot   how far each foot reaches past the tab's side
 */
export function tabOutlinePaths(
  width: number,
  height: number,
  radius: number,
  foot: number,
): TabOutlinePaths {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 2 * foot + 1 ||
    height <= 1
  ) {
    return EMPTY;
  }

  const left = foot + 0.5;
  const right = width - foot - 0.5;
  const top = 0.5;
  const base = height - 0.5;

  // Radii measured to the stroke's centre line. A tab too narrow or too short
  // for both curves gets smaller curves rather than a path that crosses itself.
  let topR = Math.max(0, Math.min(radius - 0.5, (right - left) / 2));
  let footR = Math.max(0, foot - 0.5);
  const span = base - top;
  if (topR + footR > span) {
    const k = span / (topR + footR);
    topR *= k;
    footR *= k;
  }

  const outline = [
    `A ${n(footR)} ${n(footR)} 0 0 0 ${n(left)} ${n(base - footR)}`,
    `L ${n(left)} ${n(top + topR)}`,
    `A ${n(topR)} ${n(topR)} 0 0 1 ${n(left + topR)} ${n(top)}`,
    `L ${n(right - topR)} ${n(top)}`,
    `A ${n(topR)} ${n(topR)} 0 0 1 ${n(right)} ${n(top + topR)}`,
    `L ${n(right)} ${n(base - footR)}`,
    `A ${n(footR)} ${n(footR)} 0 0 0 ${n(right + footR)} ${n(base)}`,
  ].join(" ");
  const start = left - footR;
  const end = right + footR;

  return {
    fill: `M ${n(start)} ${n(height)} L ${n(start)} ${n(base)} ${outline} L ${n(end)} ${n(height)} Z`,
    stroke: `M ${n(start)} ${n(base)} ${outline}`,
  };
}
