/**
 * The zoom range every PDF zoom path clamps to: pinch, wheel, double-tap,
 * toolbar, keyboard and the native menu. One place, so a menu can never stop
 * short of what a pinch reaches.
 */
export const MIN_ZOOM_SCALE = 0.35;

/**
 * 8× gives detail-inspection headroom (small figures, footnotes on scanned
 * textbooks). Past the canvas budget a page is drawn as viewport tiles
 * (src/editor/components/PageTiles.tsx), so 8× is sharp without an
 * ever-larger canvas.
 */
export const MAX_ZOOM_SCALE = 8;
