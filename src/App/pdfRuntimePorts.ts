import { emptyPdfEditorStore, type PdfEditorStoreApi } from "../editor/store/store";
import { capturePdfTabPreview } from "../editor/tabPreview";
import { toast } from "../editor/toast";
import { appPdfEngine } from "../pdf/engine/appEngine";
import {
  putRuntimeSession,
  rememberRuntimeCredential,
  removeRuntimeSession,
} from "../storage/runtimeSessions";
import { putTabPreview, removeTabPreview } from "../storage/tabPreviews";
import { workspaceStore } from "../workspace/appWorkspace";
import { createPdfRuntime, type PdfRuntime } from "../workspace/pdfRuntime";
import type { WorkspaceRuntimeTab } from "../workspace/types";
import { draftConflictChoice } from "./draftConflictChoice";
import { translate as t } from "./translate";

type Live = {
  activeEditor: () => PdfEditorStoreApi;
  flushDraft: () => Promise<void>;
  /** useDraftSync.discardRefusedEdits for the document on screen. */
  discardRefusedEdits: () => boolean;
  /** Closes a tab whose refused copy the reader discarded. */
  closeDiscardedTab: (tabId: string) => void;
};

/**
 * Switching tabs, going home or opening another document could not save the
 * PDF on screen. Refused for another window's newer draft, the reader can
 * export or discard; discarding closes this document, the click that was
 * blocked is not replayed.
 */
function reportFlushFailed(live: Live, tab: WorkspaceRuntimeTab, error: unknown): void {
  const asked = draftConflictChoice.offer(error, {
    discardRefusedEdits: () => live.discardRefusedEdits(),
    leave: () => live.closeDiscardedTab(tab.id),
  });
  if (asked) return;
  console.error("Failed to persist PDF before switching documents", error);
  toast.error(t("drafts.saveFailedToast"), tab.title);
}

let runtime: (PdfRuntime & { connect(next: Partial<Live>): void }) | null = null;

/**
 * The window's PDF runtime on the real engine and storage. One per window,
 * like the workspace store; App connects the editor on screen and the draft
 * flush from an effect.
 */
export function appPdfRuntime() {
  if (!runtime) {
    const live: Live = {
      activeEditor: () => emptyPdfEditorStore,
      flushDraft: async () => {},
      discardRefusedEdits: () => false,
      closeDiscardedTab: () => {},
    };
    runtime = {
      ...createPdfRuntime({
        store: workspaceStore(),
        engine: appPdfEngine,
        sessions: {
          put: putRuntimeSession,
          remove: removeRuntimeSession,
          rememberCredential: rememberRuntimeCredential,
        },
        previews: {
          capture: capturePdfTabPreview,
          put: putTabPreview,
          remove: removeTabPreview,
        },
        activeEditor: () => live.activeEditor(),
        flushDraft: () => live.flushDraft(),
        onFlushFailed: (tab, error) => reportFlushFailed(live, tab, error),
      }),
      connect(next) {
        Object.assign(live, next);
      },
    };
  }
  return runtime;
}
