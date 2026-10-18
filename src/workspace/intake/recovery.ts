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

/**
 * Picks what to restore on open: the operation log when it is newer than the
 * saved draft (its model post-dates the draft, so the draft's own model
 * becomes the newest undo step beneath it), else the draft. Page boxes come
 * from the freshly parsed file.
 */
export function chooseDraftRecovery(
  draft:
    | { lastTouched: number; model: DocumentModel; history: HistoryEntry[] }
    | null
    | undefined,
  operationLog: { lastTouched: number; model: DocumentModel } | null,
  freshPages: PageModel[],
  completedLiveOperationIds: string[],
): DraftRecovery | null {
  if (operationLog && (!draft || operationLog.lastTouched > draft.lastTouched)) {
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
