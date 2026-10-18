// Keep the dialog's orchestration seam separate from the raster engine so
// component tests can replace the expensive operation without globally
// mocking the engine's lifecycle tests in Bun's shared module registry.
export { exportCompactRasterPdf } from "./compactRasterPdf";
