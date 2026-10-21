import type { PdfEditorStoreApi } from "../editor/store/store";
import {
  filterExistingCollapsedCalloutIds,
  filterExistingCollapsedNoteIds,
} from "../editor/overlays/notePresentation";
import type { DocumentModel } from "../pdf/model/types";
import type { PendingRestore, WorkspaceRuntimeTab } from "./types";
import type { WorkspaceStore } from "./workspaceStore";

/**
 * What the reader decides about a saved draft of the PDF on screen.
 *
 * Drafts restore silently on open. Choosing "open the original" sets the draft
 * aside (deferred) and suspends autosave, so the clean baseline cannot delete
 * the draft it is protecting; the first edit after that raises the conflict
 * (pending), which the reader restores, discards or dismisses. Each decision
 * updates the live session and the tab record together.
 */
export type DraftDecisionPorts = {
  store: WorkspaceStore;
  editor: () => PdfEditorStoreApi;
  /** Deletes the draft (by draft id) but keeps its Live receipts. */
  removeDraft: (draftId: string) => void;
};

function updateActiveTab(
  store: WorkspaceStore,
  update: (tab: WorkspaceRuntimeTab) => WorkspaceRuntimeTab,
): void {
  const { activeTabId } = store.getState();
  if (activeTabId) store.getState().updateTab(activeTabId, update);
}

/** Collapsed notes and callouts that still exist in `overlays`. */
function keepCollapsedFor(
  editor: PdfEditorStoreApi,
  overlays: DocumentModel["overlays"],
): void {
  const state = editor.getState();
  state.setCollapsedNoteIds(filterExistingCollapsedNoteIds(state.collapsedNoteIds, overlays));
  state.setCollapsedCalloutIds(
    filterExistingCollapsedCalloutIds(state.collapsedCalloutIds, overlays),
  );
}

function clearDraftNotices(store: WorkspaceStore): void {
  store.getState().setSession({ pendingRestore: null, deferredDraft: null, restoredDraft: null });
  updateActiveTab(store, (tab) => ({
    ...tab,
    draftRestore: undefined,
    restoredDraft: undefined,
  }));
}

/**
 * Loads the conflicting or set-aside draft into the editor. Reached from the
 * conflict dialog and the status bar, never on plain open.
 */
export function restoreDraft({ store, editor }: DraftDecisionPorts): void {
  const { pendingRestore, deferredDraft } = store.getState().session;
  const draft = pendingRestore ?? deferredDraft;
  if (!draft) return;
  const target = editor();
  target.getState().commitRestoredDraft(
    { pages: draft.draftModelPages, overlays: draft.draftModelOverlays },
    draft.draftHistory,
    draft.completedLiveOperationIds,
  );
  keepCollapsedFor(target, target.getState().model.overlays);
  clearDraftNotices(store);
}

/**
 * Throws the conflicting draft away. Its Live receipts stay: a lost-response
 * retry must not recreate work the reader explicitly rejected.
 */
export function discardDraft({ store, editor, removeDraft }: DraftDecisionPorts): void {
  const { pendingRestore } = store.getState().session;
  if (!pendingRestore) return;
  removeDraft(pendingRestore.draftId);
  const target = editor();
  keepCollapsedFor(target, target.getState().model.overlays);
  clearDraftNotices(store);
}

/**
 * Dismissing the conflict prompt (Esc, backdrop) is not a decision: the draft
 * is set aside again and autosave stays off until the next edit asks again.
 */
export function deferDraft({ store }: DraftDecisionPorts): void {
  const { pendingRestore } = store.getState().session;
  if (!pendingRestore) return;
  store.getState().setSession({ deferredDraft: pendingRestore, pendingRestore: null });
  updateActiveTab(store, (tab) => ({
    ...tab,
    draftRestore: { mode: "deferred", draft: pendingRestore },
  }));
}

/**
 * "Open the original": back to the as-opened document, with the draft set
 * aside rather than deleted. Only while nothing was edited since the restore.
 */
export function openOriginal({ store, editor }: DraftDecisionPorts): void {
  const { restoredDraft } = store.getState().session;
  if (!restoredDraft) return;
  const target = editor();
  if (target.getState().model !== restoredDraft.committedModel) return;
  const { draft, originalModel } = restoredDraft;
  target.getState().restoreBaselineModel(originalModel);
  keepCollapsedFor(target, originalModel.overlays);
  store.getState().setSession({ restoredDraft: null, deferredDraft: draft });
  updateActiveTab(store, (tab) => ({
    ...tab,
    restoredDraft: undefined,
    draftRestore: { mode: "deferred", draft },
  }));
}

/** The first edit while a draft is set aside asks about it before any save. */
export function raiseDeferredDraft(store: WorkspaceStore, draft: PendingRestore): void {
  store.getState().setSession({ pendingRestore: draft, deferredDraft: null });
  updateActiveTab(store, (tab) => ({
    ...tab,
    draftRestore: { mode: "pending", draft },
  }));
}
