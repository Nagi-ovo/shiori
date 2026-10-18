import { MAX_ZOOM_SCALE, MIN_ZOOM_SCALE } from "../zoomLimits";

/**
 * The one zoom ladder every stepped zoom walks: the toolbar and text-view
 * +/- buttons, the keyboard and the native menu. Including 1.0 keeps 100%
 * reachable wherever a fit or a pinch left the scale. The stops below the
 * PDF floor serve views with a lower floor (Markdown / HTML text, Word).
 */
export const ZOOM_LADDER: readonly number[] = [
  0.2, 0.25, 0.3, 0.35, 0.5, 0.67, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2,
  2.5, 3, 4, 5, 6, 8,
];

/** A scale within this of a stop is on it. */
const ON_STOP = 1e-6;

/** The next stop above `scale`, at least `floor`; the top holds. */
export function zoomStepUp(scale: number, floor = MIN_ZOOM_SCALE): number {
  const next = ZOOM_LADDER.find((step) => step >= floor && step > scale + ON_STOP);
  return next ?? MAX_ZOOM_SCALE;
}

/** The next stop below `scale`, at least `floor`; the floor holds. */
export function zoomStepDown(scale: number, floor = MIN_ZOOM_SCALE): number {
  // An automatic fit may go below the floor (a 22-inch DOCX page on a
  // phone); zooming "out" must never enlarge that page back to the floor.
  if (scale <= floor + ON_STOP) return scale;
  let prev = floor;
  for (const step of ZOOM_LADDER) {
    if (step < floor) continue;
    if (step < scale - ON_STOP) prev = step;
    else break;
  }
  return prev;
}

/** A typed percent ("150", "75 %") as a scale within [floor, top]; null when it is none. */
export function typedZoom(raw: string, floor = MIN_ZOOM_SCALE): number | null {
  const percent = parseFloat(raw.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(percent) || percent <= 0) return null;
  return Math.min(MAX_ZOOM_SCALE, Math.max(floor, percent / 100));
}
