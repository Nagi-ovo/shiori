export type CanvasVirtualizationProps = {
  overscan: number;
  minOverscanItemCount?: number;
};

// Compact viewports keep the short pixel overscan (600px of render-ahead
// held several device-pixel-ratio canvases alive per direction and was the
// memory pressure behind jetsam kills on phones), but always mount the one
// adjacent page: at fit-width a phone page is taller than 200px of lookahead,
// so the next page used to start rastering only once it was already on
// screen — every page turn was a blurry preview first.
export function canvasVirtualizationProps(
  isMobile: boolean,
): CanvasVirtualizationProps {
  return {
    overscan: isMobile ? 200 : 600,
    minOverscanItemCount: 1,
  };
}
