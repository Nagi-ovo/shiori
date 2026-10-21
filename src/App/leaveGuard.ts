import type { BlockedLeave } from "./draftConflictChoice";

export type LeaveSteps = {
  flushDraft: () => Promise<void>;
  flushTextSources: () => Promise<void>;
  /** Closes the window or completes the quit. */
  leave: () => Promise<void>;
  /** Runs whenever leaving stops, e.g. to release the native quit handshake. */
  blocked?: () => void;
  discardRefusedEdits: () => boolean;
  /** DraftConflictChoice.offer: true when the reader was asked instead. */
  offerConflictChoice: (error: unknown, leave: BlockedLeave) => boolean;
  reportSaveFailed: (error: unknown) => void;
};

/**
 * The desktop window-close safeguard and quit handshake: persist the draft and
 * text sources, then leave. One guard per route; a request while one is
 * persisting is ignored, and a failure re-arms it. A copy refused for another
 * window's newer draft asks the reader to export or discard it; every other
 * failure is reported as one.
 */
export function createLeaveGuard() {
  let inFlight = false;
  return async function leaveAfterPersisting(steps: LeaveSteps): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      await steps.flushDraft();
      await steps.flushTextSources();
      await steps.leave();
    } catch (error) {
      inFlight = false;
      steps.blocked?.();
      const asked = steps.offerConflictChoice(error, {
        discardRefusedEdits: steps.discardRefusedEdits,
        leave: () => void leaveAfterPersisting(steps),
      });
      if (!asked) steps.reportSaveFailed(error);
    }
  };
}
