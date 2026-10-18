import { useEffect, useMemo, useState } from "react";
import type { DocumentModel } from "../../pdf/model/types";
import { exportSnapshotKey } from "../../editor/export/exportStatus";

/**
 * Digesting the model means serialising every page and overlay and hashing
 * the JSON. Up to this many overlays that is a couple of milliseconds and
 * worth doing synchronously so the export status never lags an edit. Past
 * it (≈180KB of JSON) the cost grows linearly — 10,000 highlights measured
 * 21–27ms, more than a 60Hz frame — so the digest moves off the render path.
 */
export const SYNC_SNAPSHOT_OVERLAY_LIMIT = 1500;

/** Runs `work` later; returns a canceller. Idle time first, a timeout as a floor. */
export type SnapshotScheduler = (work: () => void) => () => void;

export const idleSnapshotScheduler: SnapshotScheduler = (work) => {
  if (typeof requestIdleCallback === "function") {
    // The timeout keeps the status honest during continuous input: with
    // every keystroke replacing the pending job, idle time may never come.
    const id = requestIdleCallback(work, { timeout: 500 });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(work, 0);
  return () => clearTimeout(id);
};

/**
 * The export snapshot key for `model`, or null while a large model's digest
 * is still pending. Callers must treat null as "not proven clean" — the only
 * safe reading — never as clean or exported.
 *
 * A pending job is cancelled when the model changes, and a result is only
 * returned while it still belongs to the current model reference, so a late
 * digest of a superseded model can never be reported for the current one.
 */
export function useExportSnapshotKey(
  model: DocumentModel,
  schedule: SnapshotScheduler = idleSnapshotScheduler,
): string | null {
  const syncKey = useMemo(
    () =>
      model.overlays.length <= SYNC_SNAPSHOT_OVERLAY_LIMIT
        ? exportSnapshotKey(model)
        : null,
    [model],
  );
  const [deferred, setDeferred] = useState<{
    model: DocumentModel;
    key: string;
  } | null>(null);

  useEffect(() => {
    if (syncKey !== null) return;
    return schedule(() => {
      setDeferred({ model, key: exportSnapshotKey(model) });
    });
  }, [model, schedule, syncKey]);

  if (syncKey !== null) return syncKey;
  return deferred !== null && deferred.model === model ? deferred.key : null;
}
