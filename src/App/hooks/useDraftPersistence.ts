import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { DraftSyncState } from "../../editor/hooks/useDraftSync";
import { toast } from "../../editor/toast";
import { CAPABILITIES, IS_MAC } from "../../platform";
import { resolveNativeAppExit } from "../../platform/appExit";
import { safeUnlisten } from "../../platform/ipc";
import { interceptNativeWindowClose } from "../../platform/nativeEvents";
import { draftConflictChoice } from "../draftConflictChoice";
import { createLeaveGuard, type LeaveSteps } from "../leaveGuard";

interface DraftPersistenceParams {
  draftState: DraftSyncState;
  flushPendingTextSources: (tabId?: string) => Promise<void>;
  hasPendingTextSourceWrites: boolean;
  /** Whether the document on screen has nothing left to export. */
  isExported: () => boolean;
}

/**
 * App-lifecycle persistence orchestration: flush
 * the PDF draft and any pending text-source writes on every path the app can
 * be suspended or closed — tab hide / pagehide, the web beforeunload prompt,
 * and the Tauri native close-requested guard — and surface draft save
 * failures as a toast. A close or quit blocked by a copy refused for another
 * window's newer draft asks the reader to export or discard it instead
 * (leaveGuard.ts); on the web, the browser's own prompt holds the tab while
 * such a copy is unexported.
 *
 * The flush primitives (draftState, flushPendingTextSources) stay owned by
 * App because other call sites — workspace tab close, the menu exit wire —
 * share them, so they are passed in. The hook returns completeNativeExitRequest
 * for the macOS "app should terminate" menu/event wire.
 */
export function useDraftPersistence({
  draftState,
  flushPendingTextSources,
  hasPendingTextSourceWrites,
  isExported,
}: DraftPersistenceParams): {
  completeNativeExitRequest: () => Promise<void>;
} {
  const { t } = useTranslation();
  const [quitAfterPersisting] = useState(createLeaveGuard);
  const [closeAfterPersisting] = useState(createLeaveGuard);
  const lastDraftErrorRef = useRef<string | null>(null);

  const flushDraftNow = draftState.flushNowOrThrow;
  const flushDraftBeforeSuspension = draftState.flushNow;
  const { discardRefusedEdits, holdsRefusedEdits } = draftState;

  const persistThen = useCallback(
    (context: string, leave: () => Promise<void>): LeaveSteps => ({
      flushDraft: flushDraftNow,
      flushTextSources: () => flushPendingTextSources(),
      leave,
      discardRefusedEdits,
      offerConflictChoice: draftConflictChoice.offer,
      reportSaveFailed: (err) => {
        console.error(`Failed to persist documents before ${context}`, err);
        toast.error(t("documents.closeSaveFailed"));
      },
    }),
    [discardRefusedEdits, flushDraftNow, flushPendingTextSources, t],
  );

  const completeNativeExitRequest = useCallback(
    () =>
      quitAfterPersisting({
        ...persistThen("quitting", () => resolveNativeAppExit(true)),
        // Release the native handshake; discarding later re-runs the quit.
        blocked: () => void resolveNativeAppExit(false),
      }),
    [persistThen, quitAfterPersisting],
  );

  useEffect(() => {
    const flushBeforeSuspension = () => {
      void flushDraftBeforeSuspension();
      void flushPendingTextSources();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flushBeforeSuspension();
    };
    window.addEventListener("pagehide", flushBeforeSuspension);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", flushBeforeSuspension);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [flushDraftBeforeSuspension, flushPendingTextSources]);

  useEffect(() => {
    if (CAPABILITIES.nativeWindowChrome) return;
    if (!hasPendingTextSourceWrites && !holdsRefusedEdits) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      void flushPendingTextSources();
      // Unloading skips the in-app export-or-discard dialog, and no flush
      // keeps a refused copy; once it is exported, nothing is lost.
      if (!hasPendingTextSourceWrites && isExported()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [
    flushPendingTextSources,
    hasPendingTextSourceWrites,
    holdsRefusedEdits,
    isExported,
  ]);

  useEffect(() => {
    if (!CAPABILITIES.nativeWindowChrome) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      try {
        const stopListening = await interceptNativeWindowClose((destroyWindow) =>
          closeAfterPersisting(
            persistThen("closing", () =>
              IS_MAC ? destroyWindow() : resolveNativeAppExit(true),
            ),
          ),
        );
        if (disposed) safeUnlisten(stopListening);
        else unlisten = stopListening;
      } catch (err) {
        console.error("Failed to install the native close safeguard", err);
      }
    })();

    return () => {
      disposed = true;
      safeUnlisten(unlisten);
    };
  }, [closeAfterPersisting, persistThen]);

  useEffect(() => {
    if (draftState.status !== "error" || !draftState.error) {
      lastDraftErrorRef.current = null;
      return;
    }
    const errorKey = `${draftState.errorKind ?? "transient"}:${draftState.error}`;
    if (lastDraftErrorRef.current === errorKey) return;
    lastDraftErrorRef.current = errorKey;
    if (draftState.errorKind === "quota") {
      toast.error(t("drafts.saveQuotaFailedToast"), t("drafts.saveQuotaFailedDetail"));
      return;
    }
    if (draftState.errorKind === "conflict") {
      toast.error(t("drafts.saveConflictToast"), t("drafts.saveConflictDetail"));
      return;
    }
    toast.error(
      t("drafts.saveTransientFailedToast"),
      t("drafts.saveTransientFailedDetail"),
    );
  }, [draftState.error, draftState.errorKind, draftState.status, t]);

  return { completeNativeExitRequest };
}
