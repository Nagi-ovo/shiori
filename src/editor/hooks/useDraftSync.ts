import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useEditorStore } from "../store/store";
import drafts, {
  DraftSaveError,
  type DraftWriteVersion,
} from "../../storage/drafts";
import { isModelClean } from "../../pdf/model/clean";
import { readStorageEstimate } from "../../platform";
import {
  clearOperationLog,
  writeOperationLog,
} from "../../storage/operationLog";

export type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

export type DraftSyncState = {
  status: SaveStatus;
  hash: string | null;
  lastTouched: number | null;
  error: string | null;
  errorKind: "quota" | "transient" | null;
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
const draftVersionByDocument = new WeakMap<object, DraftWriteVersion | null>();

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
// is keyed by the same content hash. Re-enabling resumes saving normally.
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

  const [status, setStatus] = useState<SaveStatus>("idle");
  const [lastTouched, setLastTouched] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<"quota" | "transient" | null>(
    null,
  );
  const [usedBytes, setUsedBytes] = useState<number>(0);
  const [realUsedBytes, setRealUsedBytes] = useState<number | null>(null);
  const [quotaBytes, setQuotaBytes] = useState<number | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);

  const timerRef = useRef<number | null>(null);
  const operationLogTimerRef = useRef<number | null>(null);
  const dirtyRef = useRef<boolean>(false);
  // Unlike undoStack.length, this survives a complete Undo back to the source
  // model. The clean revision still has to delete an older saved draft.
  const persistenceStartedRef = useRef(false);
  const persistenceHashRef = useRef<string | null>(hash);
  const persistenceDocumentRef = useRef(opened?.doc ?? null);
  const persistenceReceiptsRef = useRef(completedLiveOperationIds);
  const draftVersionRef = useRef<DraftWriteVersion | null>(
    opened?.doc
      ? draftVersionByDocument.has(opened.doc)
        ? (draftVersionByDocument.get(opened.doc) ?? null)
        : (opened.draftVersion ?? null)
      : null,
  );
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
  });
  useLayoutEffect(() => {
    if (
      persistenceHashRef.current !== hash ||
      persistenceDocumentRef.current !== (opened?.doc ?? null)
    ) {
      persistenceHashRef.current = hash;
      persistenceDocumentRef.current = opened?.doc ?? null;
      persistenceStartedRef.current = false;
      persistenceReceiptsRef.current = completedLiveOperationIds;
      draftVersionRef.current = opened?.doc
        ? draftVersionByDocument.has(opened.doc)
          ? (draftVersionByDocument.get(opened.doc) ?? null)
          : (opened.draftVersion ?? null)
        : null;
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
  ]);

  // Reset transient state when the document changes. These setState calls
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
  }, [hash]);

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
    if (!snap.opened || !snap.hash) {
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
            snap.hash,
            draftVersionRef.current,
          );
        if (cleanRemovalSucceeded) {
          draftVersionRef.current = null;
          draftVersionByDocument.set(snap.opened.doc, null);
        }
      } else {
        const writtenVersion = await drafts.put({
          id: snap.hash,
          fileName: snap.opened.fileName,
          fileSize: snap.opened.fileSize,
          pdfBytes: snap.opened.bytes,
          model: snap.model,
          history: snap.undoStack,
          completedLiveOperationIds: liveOperationReceipts,
          lastTouched: now,
        });
        draftVersionRef.current = writtenVersion;
        draftVersionByDocument.set(snap.opened.doc, writtenVersion);
      }

      const revisionIsCurrent =
        revisionRef.current === revision && latestRef.current.hash === snap.hash;
      if (revisionIsCurrent) {
        if (operationLogTimerRef.current !== null) {
          window.clearTimeout(operationLogTimerRef.current);
          operationLogTimerRef.current = null;
        }
        if (!clean || cleanRemovalSucceeded) clearOperationLog(snap.hash);
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
    if (!opened || !hash || !persistenceStartedRef.current) return;
    const clean = isModelClean(model, opened.sourcePages);

    setStatus(clean ? "saving" : "dirty");
    if (operationLogTimerRef.current !== null) {
      window.clearTimeout(operationLogTimerRef.current);
      operationLogTimerRef.current = null;
    }
    if (!clean) {
      operationLogTimerRef.current = window.setTimeout(() => {
        operationLogTimerRef.current = null;
        const result = writeOperationLog(hash, model);
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
  }, [opened, model, hash, undoCount, drainLatestSave, disabled]);

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
      const { hash: logHash, model: logModel } = latestRef.current;
      if (logHash) writeOperationLog(logHash, logModel);
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
