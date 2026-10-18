import type {
  ExportQuality,
  ExportResult,
} from "../../pdf/export/exportPdf";

export type PreviewResultCache = Partial<Record<ExportQuality, ExportResult>>;

export const MAX_CACHED_PREVIEW_BYTES = 96 * 1024 * 1024;

/** Keep preview bytes under one dialog-wide budget, not one budget per mode. */
export function cachePreviewResult(
  cache: PreviewResultCache,
  quality: ExportQuality,
  result: ExportResult,
  maxBytes: number = MAX_CACHED_PREVIEW_BYTES,
): boolean {
  const retainedBuffers = new Set<ArrayBufferLike>();
  let retainedBytes = 0;
  for (const [cachedQuality, cached] of Object.entries(cache)) {
    if (cachedQuality === quality || !cached) continue;
    const buffer = cached.bytes.buffer;
    if (retainedBuffers.has(buffer)) continue;
    retainedBuffers.add(buffer);
    retainedBytes += buffer.byteLength;
  }
  const resultBytes = retainedBuffers.has(result.bytes.buffer)
    ? 0
    : result.bytes.buffer.byteLength;
  if (retainedBytes + resultBytes > maxBytes) return false;
  cache[quality] = result;
  return true;
}
