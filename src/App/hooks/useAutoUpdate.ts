import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import { CAPABILITIES, checkForUpdate, type ShioriUpdate } from "../../platform";

export type UpdateCheckState = "idle" | "checking" | "uptodate" | "error";

export interface AutoUpdateController {
  /** The update the modal is offering, or null when none is pending. */
  pendingUpdate: ShioriUpdate | null;
  setPendingUpdate: Dispatch<SetStateAction<ShioriUpdate | null>>;
  /** Inline feedback state for Settings → Updates → "Check for Updates". */
  updateCheckState: UpdateCheckState;
  updateCheckError: string | null;
  /** Run an update check; pass `true` for a user-initiated (manual) check. */
  runUpdateCheck: (manual: boolean) => Promise<void>;
}

/**
 * Owns the self-update lifecycle: the deferred
 * startup auto-check and the manual "Check for Updates" flow, plus the three
 * state atoms backing the update modal and the Settings inline feedback.
 * Extracted verbatim from the App God-component.
 *
 * `pendingUpdate` drives the modal; `updateCheckState`/`updateCheckError`
 * drive the inline Settings feedback (idle on load, transient `checking`,
 * then one of three terminal states). Only manual checks transition through
 * the terminal states — startup checks fail silently because there is
 * nowhere to show the error without surprising the user.
 */
export function useAutoUpdate(): AutoUpdateController {
  const [pendingUpdate, setPendingUpdate] = useState<ShioriUpdate | null>(null);
  const [updateCheckState, setUpdateCheckState] =
    useState<UpdateCheckState>("idle");
  const [updateCheckError, setUpdateCheckError] = useState<string | null>(null);

  const runUpdateCheck = useCallback(async (manual: boolean) => {
    if (!CAPABILITIES.nativeUpdater && !CAPABILITIES.androidDirectUpdater) return;
    if (manual) {
      setUpdateCheckState("checking");
      setUpdateCheckError(null);
    }
    try {
      const update = await checkForUpdate();
      if (update) {
        setPendingUpdate(update);
        // Don't transition the inline state — the modal takes over the
        // "you have an update" UI from here.
        if (manual) setUpdateCheckState("idle");
      } else if (manual) {
        setUpdateCheckState("uptodate");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (manual) {
        setUpdateCheckState("error");
        setUpdateCheckError(msg);
      } else {
        // Startup check failures are silent — manual check is the
        // diagnostic surface.
        console.warn("[updater] startup check failed:", msg);
      }
    }
  }, []);

  // Startup auto-check. Defer 4s so it doesn't compete with first paint
  // or with the changelog modal that pops on first launch after an
  // upgrade. Skip in dev builds — pointing dev at a stable manifest URL
  // would either 404 (if no manifest) or flag every dev session as
  // out-of-date (if the manifest version > 0.0.0).
  useEffect(() => {
    if (
      (!CAPABILITIES.nativeUpdater && !CAPABILITIES.androidDirectUpdater) ||
      import.meta.env.DEV
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      void runUpdateCheck(false);
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [runUpdateCheck]);

  return {
    pendingUpdate,
    setPendingUpdate,
    updateCheckState,
    updateCheckError,
    runUpdateCheck,
  };
}
