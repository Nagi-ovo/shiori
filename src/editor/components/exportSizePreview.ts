import type { ExportResult } from "../../pdf/export/exportPdf";
import { formatBytes } from "../../shared/format";
import {
  cachePreviewResult,
  type PreviewResultCache,
} from "../export/exportPreviewCache";
import { exportBytesForQuality, type ExportPreviewRequest } from "./exportDialogBytes";
import { EXPORT_QUALITIES, type QualityV } from "./exportPrefs";

// The export dialog's per-quality size hints and the cache of bytes behind
// them.

export type SizePreview = {
  status: "deferred" | "calculating" | "ready" | "unavailable";
  size?: number;
};

export type SizePreviewMap = Record<QualityV, SizePreview>;

export type SizePreviewState = {
  request: ExportPreviewRequest | null;
  previews: SizePreviewMap;
};

export type ExportBytesCache = {
  request: ExportPreviewRequest;
  results: PreviewResultCache;
  pending: Partial<Record<QualityV, Promise<ExportResult>>>;
};

export const PREVIEW_DEBOUNCE_MS = 220;

export async function generateSizePreview(
  request: ExportPreviewRequest,
  quality: QualityV,
  cache: ExportBytesCache,
  publish: (preview: SizePreview) => void,
): Promise<void> {
  const existing = cache.pending[quality];
  const pending = existing ?? exportBytesForQuality({ ...request, quality });
  cache.pending[quality] = pending;
  try {
    const result = await pending;
    cachePreviewResult(cache.results, quality, result);
    publish({ status: "ready", size: result.bytes.byteLength });
  } catch (err) {
    console.warn(`Unable to calculate ${quality} export size.`, err);
    publish({ status: "unavailable" });
  } finally {
    if (cache.pending[quality] === pending) delete cache.pending[quality];
  }
}

export function deferredSizePreviews(selectedQuality: QualityV): SizePreviewMap {
  return {
    original: {
      status: selectedQuality === "original" ? "calculating" : "deferred",
    },
    standard: {
      status: selectedQuality === "standard" ? "calculating" : "deferred",
    },
    compact: {
      status: selectedQuality === "compact" ? "calculating" : "deferred",
    },
  };
}

export function selectSizePreview(
  current: SizePreviewMap,
  selectedQuality: QualityV,
  cached: ExportResult | undefined,
): SizePreviewMap {
  const next = { ...current };
  for (const quality of EXPORT_QUALITIES) {
    if (quality !== selectedQuality && next[quality].status === "calculating") {
      next[quality] = { status: "deferred" };
    }
  }
  next[selectedQuality] = cached
    ? { status: "ready", size: cached.bytes.byteLength }
    : { status: "calculating" };
  return next;
}

export function unavailableSizePreviews(): SizePreviewMap {
  return {
    original: { status: "unavailable" },
    standard: { status: "unavailable" },
    compact: { status: "unavailable" },
  };
}

export function qualityHint(
  t: (key: string, values?: Record<string, unknown>) => string,
  quality: QualityV,
  preview: SizePreview,
): string {
  if (preview.status === "ready" && preview.size != null) {
    return t(`export.quality.${quality}Hint`, {
      size: formatBytes(preview.size),
    });
  }
  if (preview.status === "unavailable") return t("export.quality.sizeUnavailable");
  if (preview.status === "deferred") return t("export.quality.sizeOnSelect");
  return t("export.quality.sizeCalculating");
}
