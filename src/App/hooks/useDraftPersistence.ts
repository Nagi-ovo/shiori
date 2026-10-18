import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { DraftSyncState } from "../../editor/hooks/useDraftSync";
import { toast } from "../../editor/toast";
import { CAPABILITIES, IS_MAC } from "../../platform";
import { resolveNativeAppExit } from "../../platform/appExit";
import { safeUnlisten } from "../../platform/ipc";
import { interceptNativeWindowClose } from "../../platform/nativeEvents";

interface DraftPersistenceParams {
  draftState: DraftSyncState;
  flushPendingTextSources: (tabId?: string) => Promise<void>;
  hasPendingTextSourceWrites: boolean;
}

/**
 * App-lifecycle persistence orchestration: flush
 * the PDF draft and any pending text-source writes on every path the app can
 * be suspended or closed — tab hide / pagehide, the web beforeunload prompt,
 * and the Tauri native close-requested guard — and surface draft save
 * failures as a toast. Extracted verbatim from the App God-component.
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
}: DraftPersistenceParams): {
  completeNativeExitRequest: () => Promise<void>;
} {
  const { t } = useTranslation();
  const nativeQuitInFlightRef = useRef(false);
  const lastDraftErrorRef = useRef<string | null>(null);

  const flushDraftNow = draftState.flushNowOrThrow;
  const flushDraftBeforeSuspension = draftState.flushNow;

  const completeNativeExitRequest = useCallback(async () => {
    if (nativeQuitInFlightRef.current) return;
    nativeQuitInFlightRef.current = true;
    try {
      await flushDraftNow();
      await flushPendingTextSources();
      await resolveNativeAppExit(true);
    } catch (err) {
      nativeQuitInFlightRef.current = false;
      void resolveNativeAppExit(false);
      console.error("Failed to persist documents before quitting", err);
      toast.error(t("documents.closeSaveFailed"));
    }
  }, [flushDraftNow, flushPendingTextSources, t]);

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
    if (CAPABILITIES.nativeWindowChrome || !hasPendingTextSourceWrites) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      void flushPendingTextSources();
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [flushPendingTextSources, hasPendingTextSourceWrites]);

  useEffect(() => {
    if (!CAPABILITIES.nativeWindowChrome) return;
    let disposed = false;
    let closeInFlight = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      try {
        const stopListening = await interceptNativeWindowClose(async (destroyWindow) => {
          if (closeInFlight) return;
          closeInFlight = true;
          try {
            await flushDraftNow();
            await flushPendingTextSources();
            if (IS_MAC) await destroyWindow();
            else await resolveNativeAppExit(true);
          } catch (err) {
            closeInFlight = false;
            console.error("Failed to persist documents before closing", err);
            toast.error(t("documents.closeSaveFailed"));
          }
        });
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
  }, [flushDraftNow, flushPendingTextSources, t]);

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
    toast.error(
      t("drafts.saveTransientFailedToast"),
      t("drafts.saveTransientFailedDetail"),
    );
  }, [draftState.error, draftState.errorKind, draftState.status, t]);

  return { completeNativeExitRequest };
}
