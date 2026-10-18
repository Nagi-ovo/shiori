/**
 * Drop the bitmap behind a canvas immediately instead of waiting for the DOM
 * node and its WebKit graphics resources to be garbage-collected.
 */
export function releaseCanvasBackingStore(
  canvas: HTMLCanvasElement | null,
): void {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}
