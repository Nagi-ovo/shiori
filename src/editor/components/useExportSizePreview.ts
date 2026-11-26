import { useEffect, useRef, useState } from "react";
import type { ExportPreviewRequest } from "./exportDialogBytes";
import type { QualityV } from "./exportPrefs";
import {
  PREVIEW_DEBOUNCE_MS,
  deferredSizePreviews,
  generateSizePreview,
  selectSizePreview,
  unavailableSizePreviews,
  type ExportBytesCache,
  type SizePreviewState,
} from "./exportSizePreview";

export function useExportSizePreview(previewRequest: ExportPreviewRequest | null, quality: QualityV) {
  const previewCacheRef = useRef<ExportBytesCache | null>(null);
  const previewQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [sizePreviewState, setSizePreviewState] =
    useState<SizePreviewState>(() => ({
      request: null,
      previews: deferredSizePreviews(quality),
    }));

  useEffect(() => {
    if (!previewRequest) {
      previewCacheRef.current = null;
      return;
    }

    let cancelled = false;
    let cache = previewCacheRef.current;
    if (!cache || cache.request !== previewRequest) {
      cache = { request: previewRequest, results: {}, pending: {} };
      previewCacheRef.current = cache;
      setSizePreviewState({
        request: previewRequest,
        previews: deferredSizePreviews(quality),
      });
    } else {
      const cached = cache.results[quality];
      setSizePreviewState((current) => ({
        request: previewRequest,
        previews: selectSizePreview(
          current.request === previewRequest
            ? current.previews
            : deferredSizePreviews(quality),
          quality,
          cached,
        ),
      }));
      if (cached) return;
    }

    const timer = window.setTimeout(() => {
      const work = previewQueueRef.current.then(async () => {
        if (cancelled || previewCacheRef.current !== cache) return;
        await generateSizePreview(previewRequest, quality, cache, (preview) => {
          if (cancelled || previewCacheRef.current !== cache) return;
          setSizePreviewState((current) => ({
            request: previewRequest,
            previews: {
              ...(current.request === previewRequest
                ? current.previews
                : deferredSizePreviews(quality)),
              [quality]: preview,
            },
          }));
        });
      });
      previewQueueRef.current = work.then(
        () => undefined,
        () => undefined,
      );
    }, PREVIEW_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [previewRequest, quality]);

  const previews = !previewRequest
    ? unavailableSizePreviews()
    : sizePreviewState.request === previewRequest
      ? sizePreviewState.previews
      : deferredSizePreviews(quality);
  return { previews, cacheRef: previewCacheRef };
}
