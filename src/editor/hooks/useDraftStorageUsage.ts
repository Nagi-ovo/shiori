import { useCallback, useEffect, useRef, useState } from "react";
import drafts from "../../storage/drafts";
import { readStorageEstimate } from "../../platform";

export type DraftStorageUsage = {
  usedBytes: number;
  realUsedBytes: number | null;
  quotaBytes: number | null;
  persisted: boolean | null;
};

/**
 * Draft storage telemetry for the status bar: the drafts' total size and the
 * browser's storage estimate, read on mount, whenever the drafts change, and
 * after every save through `refreshAfterSave`.
 */
export function useDraftStorageUsage(): DraftStorageUsage & {
  refreshAfterSave: () => void;
} {
  const [usedBytes, setUsedBytes] = useState<number>(0);
  const [realUsedBytes, setRealUsedBytes] = useState<number | null>(null);
  const [quotaBytes, setQuotaBytes] = useState<number | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    // Reset on mount (not just at init): under StrictMode the dev remount would
    // otherwise leave this stuck false and drop post-save estimate refreshes.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // One-time fetch of current storage usage.
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void drafts.totalBytes().then((n) => {
        if (!cancelled) setUsedBytes(n);
      });
      void readStorageEstimate().then((estimate) => {
        if (cancelled) return;
        setRealUsedBytes(estimate.usage);
        setQuotaBytes(estimate.quota);
        setPersisted(estimate.persisted);
      });
    };
    refresh();
    const unsubscribe = drafts.subscribe(refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // Storage telemetry is informative, not part of the durability
  // transaction. Never hold close/quit open because an estimate API stalls.
  const refreshAfterSave = useCallback(() => {
    void Promise.all([drafts.totalBytes(), readStorageEstimate()])
      .then(([total, estimate]) => {
        if (!mountedRef.current) return;
        setUsedBytes(total);
        setRealUsedBytes(estimate.usage);
        setQuotaBytes(estimate.quota);
        setPersisted(estimate.persisted);
      })
      .catch((err) => {
        console.warn("Failed to refresh draft storage usage:", err);
      });
  }, []);

  return { usedBytes, realUsedBytes, quotaBytes, persisted, refreshAfterSave };
}
