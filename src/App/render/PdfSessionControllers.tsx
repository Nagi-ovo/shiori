import { useCallback, type MutableRefObject, type ReactNode } from "react";
import { useEditorStoreApi } from "../../editor/store/store";
import {
  useActiveWorkspaceTab,
  useWorkspace,
  workspaceStore,
} from "../../workspace/appWorkspace";
import { raiseDeferredDraft } from "../../workspace/draftDecisions";
import type { PendingRestore } from "../../workspace/types";
import { DeferredDraftEditWatcher } from "./persisters";
import {
  PdfDraftController,
  type PdfDraftControllerApi,
} from "./PdfDraftController";
import {
  PdfExportController,
  type PdfExportControllerApi,
} from "./PdfExportController";
import { PdfLiveBridge } from "./PdfLiveBridge";

function escalateDeferredDraftOnEdit(draft: PendingRestore): void {
  raiseDeferredDraft(workspaceStore(), draft);
}

/**
 * The active PDF's session controllers — draft autosave, export status, the
 * set-aside draft's edit watcher and the Live bridge — around whichever
 * screen the window shows. One mount for every screen, so going from a
 * document to home or to an error never restarts a draft flush in progress.
 */
export function PdfSessionControllers({
  draftControllerRef,
  exportControllerRef,
  flushPendingTextSources,
  hasPendingTextSourceWrites,
  transitioning,
  children,
}: {
  draftControllerRef: MutableRefObject<PdfDraftControllerApi | null>;
  exportControllerRef: MutableRefObject<PdfExportControllerApi | null>;
  flushPendingTextSources: (tabId?: string) => Promise<void>;
  hasPendingTextSourceWrites: boolean;
  /** A Live context switch is under way. */
  transitioning: boolean;
  children: ReactNode;
}) {
  const editorStore = useEditorStoreApi();
  const activeHash = useWorkspace((state) => state.session.activeHash);
  const exportBaselineSnapshot = useWorkspace(
    (state) => state.session.exportBaselineSnapshot,
  );
  const lastExport = useWorkspace((state) => state.session.lastExport);
  const pendingRestore = useWorkspace((state) => state.session.pendingRestore);
  const deferredDraft = useWorkspace((state) => state.session.deferredDraft);
  const activeTab = useActiveWorkspaceTab();
  // A draft save refused for another window's newer work blocks leaving the
  // document only while this copy is unexported.
  const isExported = useCallback(() => {
    const kind = exportControllerRef.current?.status.kind;
    return kind === "clean" || kind === "exported";
  }, [exportControllerRef]);
  return (
    <PdfDraftController
      hash={activeHash}
      disabled={pendingRestore !== null || deferredDraft !== null}
      isExported={isExported}
      flushPendingTextSources={flushPendingTextSources}
      hasPendingTextSourceWrites={hasPendingTextSourceWrites}
      apiRef={draftControllerRef}
    >
      <PdfExportController
        documentHash={activeHash}
        baselineSnapshot={exportBaselineSnapshot}
        lastExport={lastExport}
        apiRef={exportControllerRef}
      >
        <DeferredDraftEditWatcher
          deferredDraft={deferredDraft}
          onEdit={escalateDeferredDraftOnEdit}
        />
        <PdfLiveBridge
          activeTab={
            activeTab?.kind === "pdf"
              ? {
                  id: activeTab.id,
                  title: activeTab.title,
                  status: activeTab.status,
                  hash: activeTab.hash ?? null,
                  sourcePath:
                    activeTab.source.type === "path"
                      ? activeTab.source.path
                      : null,
                  sessionDoc: editorStore.getState().opened?.doc ?? null,
                }
              : null
          }
          activeHash={activeHash}
          transitioning={transitioning}
          restoreDecisionPending={
            pendingRestore !== null || deferredDraft !== null
          }
          exportBaselineSnapshot={exportBaselineSnapshot}
        />
        {children}
      </PdfExportController>
    </PdfDraftController>
  );
}
