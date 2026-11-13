export const DOCX_MIN_ZOOM = 0.2;
// The Word engine's `setZoom` refuses anything outside [0.1, 5] instead of
// clamping, and the React adapter remembers the refused prop as applied. A
// 6× or 8× zoom left the engine painting the old scale while the pinch
// anchor math assumed the new one: the page jumped on every later gesture.
export const DOCX_MAX_ZOOM = 5;

// Manual zoom stops at 20% so the controls remain useful. Automatic fit has
// a different job: it must contain every valid Word page in the viewport.
// The renderer itself accepts 10%, which is low enough for OOXML's 22-inch
// maximum page width on the narrowest supported phone viewport.
export const DOCX_AUTO_FIT_MIN_ZOOM = 0.1;

const DOCX_FIT_INLINE_GUTTER_PX = 16;

export type DocxFitGeometry = {
  viewportWidth: number;
  naturalPageWidth: number;
};

export function measureDocxFitGeometry(
  host: HTMLElement,
  measuredAtZoom: number,
): DocxFitGeometry | null {
  const scroller = host.querySelector<HTMLElement>(
    ".shioriDocxViewer__surface",
  );
  if (!scroller || measuredAtZoom <= 0) return null;
  const pageWidths = Array.from(
    host.querySelectorAll<HTMLElement>(
      ".docx-page",
    ),
  )
    .map((page) => page.getBoundingClientRect().width)
    .filter((width) => Number.isFinite(width) && width > 0);
  if (pageWidths.length === 0 || scroller.clientWidth <= 0) return null;
  return {
    viewportWidth: scroller.clientWidth,
    naturalPageWidth: Math.max(...pageWidths) / measuredAtZoom,
  };
}

export function fitDocxZoomForWidth(
  viewportWidth: number,
  naturalPageWidth: number,
): number {
  if (viewportWidth <= 0 || naturalPageWidth <= 0) return 1;
  const availableWidth = Math.max(1, viewportWidth - DOCX_FIT_INLINE_GUTTER_PX);
  return Number(
    Math.max(
      DOCX_AUTO_FIT_MIN_ZOOM,
      Math.min(1, availableWidth / naturalPageWidth),
    ).toFixed(3),
  );
}
