import { DraftSaveError } from "../storage/drafts";

/**
 * A leave the strict draft flush refused because another window on the same
 * file saved newer work (audit B034): closing the tab or the window,
 * quitting, or putting another document on screen.
 */
export type BlockedLeave = {
  /**
   * Drops the copy the refusal left unsaved (useDraftSync); false when there
   * is none any more, and then nothing may leave.
   */
  discardRefusedEdits: () => boolean;
  /** Carries out the leave that was blocked; the strict flush now passes. */
  leave: () => void;
};

export function isDraftConflict(error: unknown): boolean {
  return error instanceof DraftSaveError && error.kind === "conflict";
}

/**
 * The reader's way out of a leave blocked by a refused copy. Exporting stays
 * the safe default (once exported, the flush passes on its own); discarding
 * drops this window's copy and lets the blocked leave go on. Any other save
 * failure is not offered here: a save may still keep those edits.
 */
export function createDraftConflictChoice() {
  let blocked: BlockedLeave | null = null;
  const listeners = new Set<() => void>();
  const settle = () => {
    const was = blocked;
    blocked = null;
    if (was) for (const listener of listeners) listener();
    return was;
  };
  return {
    /** True when the reader was asked; false leaves reporting to the caller. */
    offer(error: unknown, leave: BlockedLeave): boolean {
      if (!isDraftConflict(error)) return false;
      blocked = leave;
      for (const listener of listeners) listener();
      return true;
    },
    pending: () => blocked !== null,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    discard(): void {
      const leave = settle();
      if (leave?.discardRefusedEdits()) leave.leave();
    },
    exportCopy(openExport: () => void): void {
      settle();
      openExport();
    },
    dismiss(): void {
      settle();
    },
  };
}

export type DraftConflictChoice = ReturnType<typeof createDraftConflictChoice>;

/** The window's choice; the dialog in AppDialogs shows it. */
export const draftConflictChoice = createDraftConflictChoice();
