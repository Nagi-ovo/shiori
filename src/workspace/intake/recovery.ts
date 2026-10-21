import type { HistoryEntry } from "../../editor/store/store";
import type { DocumentModel, PageModel } from "../../pdf/model/types";

function reconcileRecoveredPagesWithSource(
  recoveredPages: PageModel[],
  freshPages: PageModel[],
): PageModel[] {
  return recoveredPages.map((page) => {
    if (page.blank === true || page.sourceIndex < 0) {
      return { ...page, originXPt: undefined, originYPt: undefined };
    }
    const fresh = freshPages.find((candidate) =>
      candidate.sourceIndex === page.sourceIndex
    );
    if (!fresh) return page;
    return {
      ...page,
      widthPt: fresh.widthPt,
      heightPt: fresh.heightPt,
      originXPt: fresh.originXPt,
      originYPt: fresh.originYPt,
    };
  });
}

// Snapshot history shares the draft model's page-id lineage, so it needs the
// same source-dimension reconciliation. Compact overlay batches contain no
// page model and already refer to that stable lineage.
function reconcileRecoveredHistoryWithSource(
  history: HistoryEntry[],
  freshPages: PageModel[],
): HistoryEntry[] {
  return history.map((entry) => {
    if ((entry as { kind?: unknown }).kind === "overlay-batch") return entry;
    const snapshot = entry as DocumentModel;
    return {
      pages: reconcileRecoveredPagesWithSource(snapshot.pages, freshPages),
      overlays: snapshot.overlays,
    };
  });
}

export type DraftRecovery = {
  lastTouched: number;
  pages: PageModel[];
  overlays: DocumentModel["overlays"];
  history: HistoryEntry[];
  completedLiveOperationIds: string[];
};

// Whether a log's writer last saw this very row. Logs from older builds name
// no row and are trusted as before.
function logIsBasedOn(
  base: { lastTouched: number; revision: string | null } | null | undefined,
  draft: { lastTouched: number; revision?: string | null },
): boolean {
  if (base === undefined) return true;
  return (
    base !== null &&
    base.lastTouched === draft.lastTouched &&
    base.revision === (draft.revision ?? null)
  );
}

/**
 * Picks what to restore on open: the operation log when it is newer than the
 * saved draft and was written on top of it (its model post-dates the draft,
 * so the draft's own model becomes the newest undo step beneath it), else
 * the draft. A log written over an older row, which another window has saved
 * over since, loses to that window's draft. Page boxes come from the freshly
 * parsed file.
 */
export function chooseDraftRecovery(
  draft:
    | {
        lastTouched: number;
        revision?: string | null;
        model: DocumentModel;
        history: HistoryEntry[];
      }
    | null
    | undefined,
  operationLog: {
    lastTouched: number;
    model: DocumentModel;
    base?: { lastTouched: number; revision: string | null } | null;
  } | null,
  freshPages: PageModel[],
  completedLiveOperationIds: string[],
): DraftRecovery | null {
  if (
    operationLog &&
    (!draft ||
      (operationLog.lastTouched > draft.lastTouched &&
        logIsBasedOn(operationLog.base, draft)))
  ) {
    return {
      lastTouched: operationLog.lastTouched,
      pages: reconcileRecoveredPagesWithSource(
        operationLog.model.pages,
        freshPages,
      ),
      overlays: operationLog.model.overlays,
      history: reconcileRecoveredHistoryWithSource(
        draft ? [...draft.history, draft.model] : [],
        freshPages,
      ),
      completedLiveOperationIds,
    };
  }
  if (!draft) return null;
  return {
    lastTouched: draft.lastTouched,
    pages: reconcileRecoveredPagesWithSource(draft.model.pages, freshPages),
    overlays: draft.model.overlays,
    history: reconcileRecoveredHistoryWithSource(draft.history, freshPages),
    completedLiveOperationIds,
  };
}
