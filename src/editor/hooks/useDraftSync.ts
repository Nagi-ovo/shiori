import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useEditorStore } from "../store/store";
import drafts, { DraftSaveError } from "../../storage/drafts";
import { isModelClean } from "../../pdf/model/clean";
import { readStorageEstimate } from "../../platform";
import {
  clearOperationLog,
  readOperationLog,
  writeOperationLog,
} from "../../storage/operationLog";
import { draftIdForPayload } from "../../storage/draftIdentity";
import {
  observedDraftVersion,
  rememberDraftVersion,
} from "../../storage/draftVersions";

export type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

export type DraftSyncState = {
  status: SaveStatus;
  hash: string | null;
  lastTouched: number | null;
  error: string | null;
  errorKind: DraftSaveError["kind"] | null;
  usedBytes: number;
  realUsedBytes: number | null;
  quotaBytes: number | null;
  persisted: boolean | null;
  // Cancel the debounce timer and synchronously flush the current model to
  // IndexedDB. Awaiting this before closing the document guarantees no
  // last-moment edits (within the 800ms debounce window) are lost.
  flushNow: () => Promise<void>;
  // Close/exit paths use the strict variant so a failed durable write keeps
  // the document and window alive. Normal autosave still reports through
  // `status`/`error` without creating unhandled promise rejections.
  flushNowOrThrow: () => Promise<void>;
};

export const SAVE_DEBOUNCE_MS = 800;
const OPERATION_LOG_DEBOUNCE_MS = 250;

// Watches the current document model and persists a debounced snapshot to
// IndexedDB whenever the user has committed at least one edit.
//
// Key design points:
// - Opening a fresh PDF (no draft) does NOT create a draft until the first
//   commit. A session latch remembers that edit even after Undo reaches the
//   clean source model, so an older saved draft is removed instead of revived.
// - Opening a restored PDF keeps its existing draft fresh on the next commit.
// - Every successful save refreshes totalBytes so the status bar stays honest.
// - flushNow() is exposed so UI actions (e.g., clicking Home) can drain the
//   pending debounce before tearing the document down.
// `disabled` suspends all persistence (the debounced put AND the op-log).
// App.tsx sets it while a draft-restore decision is pending so that an edit
// made before the user chooses cannot overwrite the un-restored draft, which
// has the same draft id. Re-enabling resumes saving normally.
//
// Drafts and the op-log are keyed by the draft id (storage/draftIdentity.ts):
// the hash, qualified by the path or web file handle the document opened
// from, so the same bytes in two tabs keep two drafts. Live receipts stay
// keyed by the hash alone.
export function useDraftSync(
  hash: string | null,
  disabled = false,
): DraftSyncState {
  const opened = useEditorStore((s) => s.opened);
  const model = useEditorStore((s) => s.model);
  const undoStack = useEditorStore((s) => s.undoStack);
  const completedLiveOperationIds = useEditorStore(
    (s) => s.completedLiveOperationIds,
  );
  const undoCount = undoStack.length;
  const draftId = hash && opened ? draftIdForPayload(hash, opened) : hash;

  const [status, setStatus] = useState<SaveStatus>("idle");
  const [lastTouched, setLastTouched] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<DraftSaveError["kind"] | null>(null);
  const [usedBytes, setUsedBytes] = useState<number>(0);
  const [realUsedBytes, setRealUsedBytes] = useState<number | null>(null);
  const [quotaBytes, setQuotaBytes] = useState<number | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);

  const timerRef = useRef<number | null>(null);
  const operationLogTimerRef = useRef<number | null>(null);
  // Stamp of the clean op-log a suspension wrote (flushPendingSave).
  const cleanOperationLogStampRef = useRef<number | null>(null);
  // lastTouched of the draft this hook last wrote. Recovery prefers the log
  // only when it is strictly newer, so a clean log must be stamped past it.
  const savedDraftStampRef = useRef(0);
  const dirtyRef = useRef<boolean>(false);
  // Unlike undoStack.length, this survives a complete Undo back to the source
  // model. The clean revision still has to delete an older saved draft.
  const persistenceStartedRef = useRef(false);
  const persistenceDraftIdRef = useRef<string | null>(draftId);
  const persistenceDocumentRef = useRef(opened?.doc ?? null);
  const persistenceReceiptsRef = useRef(completedLiveOperationIds);
  const draftVersionRef = useRef(observedDraftVersion(opened, draftId));
  // Two windows on one file share a draft id, so every save names the row this
  // one last saw. Once a save is refused, no crash logs go there until an
  // open reads the row again.
  const conflictedDraftIdRef = useRef<string | null>(null);
  const ownLogStampRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const revisionRef = useRef(0);
  const saveDrainInFlightRef = useRef<Promise<void> | null>(null);
  // Keep a mutable snapshot of the latest inputs so the timer callback always
  // flushes current state even if the timer was scheduled with stale values.
  // A layout effect publishes the new revision before async IndexedDB work can
  // resume and incorrectly mark an intervening edit as durable.
  const latestRef = useRef({
    opened,
    model,
    undoStack,
    completedLiveOperationIds,
    hash,
    draftId,
  });
  useLayoutEffect(() => {
    if (
      persistenceDraftIdRef.current !== draftId ||
      persistenceDocumentRef.current !== (opened?.doc ?? null)
    ) {
      persistenceDraftIdRef.current = draftId;
      persistenceDocumentRef.current = opened?.doc ?? null;
      persistenceStartedRef.current = false;
      persistenceReceiptsRef.current = completedLiveOperationIds;
      draftVersionRef.current = observedDraftVersion(opened, draftId);
      if (opened?.draftVersion) conflictedDraftIdRef.current = null;
    } else if (persistenceReceiptsRef.current !== completedLiveOperationIds) {
      // A Live commit can be immediately undone before React observes a
      // non-empty undo stack. The new receipt reference still proves a real
      // authorized edit occurred and its clean revision must be persisted.
      persistenceStartedRef.current = true;
      persistenceReceiptsRef.current = completedLiveOperationIds;
    }
    if (opened && hash && undoStack.length > 0) {
      persistenceStartedRef.current = true;
    }
    revisionRef.current += 1;
    latestRef.current = {
      opened,
      model,
      undoStack,
      completedLiveOperationIds,
      hash,
      draftId,
    };
    // Publish dirtiness in the same commit as the new model. A native quit can
    // arrive before passive effects; it must still see this revision to drain.
    if (
      !disabled &&
      opened &&
      hash &&
      persistenceStartedRef.current
    ) {
      dirtyRef.current = true;
    }
  }, [
    disabled,
    opened,
    model,
    undoStack,
    completedLiveOperationIds,
    hash,
    draftId,
  ]);

  // Reset transient state when the document changes (two tabs of the same
  // bytes share a hash, not a draft id). These setState calls
  // are a legitimate sync to document-switch input; the lint rule targets
  // render-time cascades, not this pattern.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus("idle");
    setLastTouched(null);
    setError(null);
    setErrorKind(null);
    dirtyRef.current = false;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (operationLogTimerRef.current !== null) {
      window.clearTimeout(operationLogTimerRef.current);
      operationLogTimerRef.current = null;
    }
  }, [draftId]);

  useEffect(
    () => () => {
      if (operationLogTimerRef.current !== null) {
        window.clearTimeout(operationLogTimerRef.current);
      }
    },
    [],
  );

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

  // Persist one immutable revision. Only that same revision may clear dirty
  // state or the crash-recovery operation log; if the user edits while the
  // write is awaiting IndexedDB, the drain loop below immediately saves again.
  const performSave = useCallback(async () => {
    const revision = revisionRef.current;
    const snap = latestRef.current;
    if (!snap.opened || !snap.hash || !snap.draftId) {
      dirtyRef.current = false;
      return;
    }
    try {
      const now = Date.now();
      const clean = isModelClean(snap.model, snap.opened.sourcePages);
      let cleanRemovalSucceeded = false;
      const liveOperationReceipts = [...snap.completedLiveOperationIds];
      if (liveOperationReceipts.length > 0) {
        // The ledger is independent of draft recovery. Persist it first so a
        // clean-baseline save cannot delete the final durable idempotency copy.
        await drafts.mergeLiveOperationReceipts(
          snap.hash,
          liveOperationReceipts,
        );
      }
      if (clean) {
        cleanRemovalSucceeded =
          await drafts.removeDraftPreservingLiveOperationReceiptsIfVersion(
            snap.draftId,
            draftVersionRef.current,
          );
        if (cleanRemovalSucceeded) {
          draftVersionRef.current = null;
          rememberDraftVersion(snap.opened.doc, snap.draftId, null);
        }
      } else {
        const writtenVersion = await drafts.put({
          id: snap.draftId,
          fileName: snap.opened.fileName,
          fileSize: snap.opened.fileSize,
          pdfBytes: snap.opened.bytes,
          model: snap.model,
          history: snap.undoStack,
          completedLiveOperationIds: liveOperationReceipts,
          lastTouched: now,
          // Another window on the same file may have saved since this one
          // last read or wrote the row; its work must not be replaced.
          expectedVersion: draftVersionRef.current,
        });
        draftVersionRef.current = writtenVersion;
        rememberDraftVersion(snap.opened.doc, snap.draftId, writtenVersion);
        savedDraftStampRef.current = now;
      }

      const revisionIsCurrent =
        revisionRef.current === revision &&
        latestRef.current.draftId === snap.draftId;
      if (revisionIsCurrent) {
        if (operationLogTimerRef.current !== null) {
          window.clearTimeout(operationLogTimerRef.current);
          operationLogTimerRef.current = null;
        }
        if (!clean || cleanRemovalSucceeded) clearOperationLog(snap.draftId);
        // A refused removal means another writer's draft is newer; the clean
        // log a suspension wrote must not outrank it on the next open.
        else if (
          readOperationLog(snap.draftId)?.lastTouched ===
          cleanOperationLogStampRef.current
        ) {
          clearOperationLog(snap.draftId);
        }
        setLastTouched(clean ? null : now);
        setStatus(clean ? "idle" : "saved");
        setError(null);
        setErrorKind(null);
        dirtyRef.current = false;
      }

      // Storage telemetry is informative, not part of the durability
      // transaction. Never hold close/quit open because an estimate API stalls.
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
    } catch (err) {
      console.error("Draft save failed:", err);
      const draftError = err instanceof DraftSaveError ? err : null;
      if (draftError?.kind === "conflict") {
        conflictedDraftIdRef.current = snap.draftId;
        if (operationLogTimerRef.current !== null) {
          window.clearTimeout(operationLogTimerRef.current);
          operationLogTimerRef.current = null;
        }
        const log = readOperationLog(snap.draftId);
        if (log && log.lastTouched === ownLogStampRef.current) clearOperationLog(snap.draftId);
      }
      setError(draftError?.message || (err as Error).message || "unknown");
      setErrorKind(draftError?.kind ?? "transient");
      setStatus("error");
      throw err;
    }
  }, []);

  // One shared drain serializes autosave, explicit close, tab switching, and
  // app exit. Every caller joins the same promise; a revision that arrives
  // mid-write keeps `dirtyRef` true, so the loop cannot resolve on stale data.
  const drainLatestSave = useCallback((): Promise<void> => {
    const inFlight = saveDrainInFlightRef.current;
    if (inFlight) return inFlight;
    const promise = (async () => {
      while (dirtyRef.current) await performSave();
    })();
    saveDrainInFlightRef.current = promise;
    const clearInFlight = () => {
      if (saveDrainInFlightRef.current === promise) {
        saveDrainInFlightRef.current = null;
      }
    };
    void promise.then(clearInFlight, clearInFlight);
    return promise;
  }, [performSave]);

  // Trigger debounced save whenever model changes AFTER a real edit.
  useEffect(() => {
    if (disabled) {
      // A restore decision is pending; keep the on-disk draft untouched and
      // cancel any timer scheduled before suppression kicked in.
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (operationLogTimerRef.current !== null) {
        window.clearTimeout(operationLogTimerRef.current);
        operationLogTimerRef.current = null;
      }
      return;
    }
    if (!opened || !draftId || !persistenceStartedRef.current) return;
    const clean = isModelClean(model, opened.sourcePages);

    setStatus(clean ? "saving" : "dirty");
    if (operationLogTimerRef.current !== null) {
      window.clearTimeout(operationLogTimerRef.current);
      operationLogTimerRef.current = null;
    }
    if (!clean) {
      operationLogTimerRef.current = window.setTimeout(() => {
        operationLogTimerRef.current = null;
        if (conflictedDraftIdRef.current === draftId) return;
        ownLogStampRef.current = Date.now();
        const result = writeOperationLog(draftId, model, ownLogStampRef.current);
        if (result !== "written") {
          // The op-log second tier couldn't capture this doc (too large for
          // localStorage, or storage unavailable). Don't wait out the longer
          // IndexedDB debounce — flush the primary save now so a crash can't
          // lose more than the current edit burst.
          if (timerRef.current !== null) {
            window.clearTimeout(timerRef.current);
            timerRef.current = null;
          }
          void drainLatestSave().catch(() => undefined);
        }
      }, OPERATION_LOG_DEBOUNCE_MS);
    }
    dirtyRef.current = true;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);

    if (clean) {
      void drainLatestSave().catch(() => undefined);
      return;
    }

    timerRef.current = window.setTimeout(() => {
      setStatus("saving");
      void drainLatestSave().catch(() => undefined);
    }, SAVE_DEBOUNCE_MS);

    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, [opened, model, draftId, undoCount, drainLatestSave, disabled]);

  const flushPendingSave = useCallback(async (throwOnError: boolean) => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    // Don't drain to disk while a restore decision is pending — that is
    // exactly the overwrite we are protecting the un-restored draft from.
    if (disabled || !dirtyRef.current) return;
    // The IndexedDB write below is async and reads before it writes, so a
    // page torn down on pagehide can lose it. Land the pending op-log tier
    // synchronously first; a successful save clears it again.
    if (operationLogTimerRef.current !== null) {
      window.clearTimeout(operationLogTimerRef.current);
      operationLogTimerRef.current = null;
      const { draftId: logId, model: logModel } = latestRef.current;
      if (logId && conflictedDraftIdRef.current !== logId) {
        ownLogStampRef.current = Date.now();
        writeOperationLog(logId, logModel, ownLogStampRef.current);
      }
    } else {
      // Undo back to the original deletes the saved draft (or an older log),
      // which teardown can cut short too. A newer clean log outranks both.
      const { draftId: logId, model: logModel, opened: logOpened } =
        latestRef.current;
      if (
        logId &&
        logOpened &&
        conflictedDraftIdRef.current !== logId &&
        isModelClean(logModel, logOpened.sourcePages) &&
        (draftVersionRef.current !== null || readOperationLog(logId))
      ) {
        cleanOperationLogStampRef.current = Math.max(
          Date.now(),
          savedDraftStampRef.current + 1,
          (readOperationLog(logId)?.lastTouched ?? 0) + 1,
        );
        writeOperationLog(logId, logModel, cleanOperationLogStampRef.current);
      }
    }
    setStatus("saving");
    try {
      await drainLatestSave();
    } catch (err) {
      if (throwOnError) throw err;
    }
  }, [drainLatestSave, disabled]);

  const flushNow = useCallback(
    () => flushPendingSave(false),
    [flushPendingSave],
  );
  const flushNowOrThrow = useCallback(
    () => flushPendingSave(true),
    [flushPendingSave],
  );

  return useMemo(
    () => ({
      status,
      hash,
      lastTouched,
      error,
      errorKind,
      usedBytes,
      realUsedBytes,
      quotaBytes,
      persisted,
      flushNow,
      flushNowOrThrow,
    }),
    [
      error,
      errorKind,
      flushNow,
      flushNowOrThrow,
      hash,
      lastTouched,
      persisted,
      quotaBytes,
      realUsedBytes,
      status,
      usedBytes,
    ],
  );
}
