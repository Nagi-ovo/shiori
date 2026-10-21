import { exportSnapshotKey } from "../editor/export/exportStatus";
import {
  emptyPdfEditorStore,
  useAppStore,
  type PdfEditorStoreApi,
} from "../editor/store/store";
import {
  getTabEditorStore,
  touchTabEditorStore,
} from "../editor/store/tabStoreRegistry";
import { toast } from "../editor/toast";
import { createSerialQueue } from "../shared/serialQueue";
import {
  setActiveHash,
  setActiveWorkspaceTabId,
  setDeferredDraft,
  setExportBaselineSnapshot,
  setLastExport,
  setPendingRestore,
  setRestoredDraft,
  updateTab,
  workspaceStore,
} from "../workspace/appWorkspace";
import { coldLoadTab, type ColdLoadPorts } from "../workspace/intake/coldLoad";
import type { PendingPassword } from "../workspace/intake/types";
import type { PdfRuntime } from "../workspace/pdfRuntime";
import {
  activateTab,
  closeTab,
  goHome,
} from "../workspace/tabLifecycle";
import { workspaceCacheIdsForTab } from "../workspace/tabSources";
import type { WorkspaceRuntimeTab } from "../workspace/types";
import { planTabActivation } from "./tabActivation";
import { recordTextRecent } from "./textRecents";
import type { createAppTextSources } from "./textSourcePorts";
import { translate as t } from "./translate";
import { inactiveTabNeedsExport } from "./workspaceLists";
import { removeWorkspaceSourceIfUnreferenced } from "./workspaceStorage";

/**
 * A password prompt that is dismissed, or left behind by a switch, is final:
 * `unavailable` shows the reason with an explicit retry, where `unloaded`
 * would reload the tab, and so reopen the dialog, the next time it is shown.
 */
export function makePasswordPromptRetryable(pending: PendingPassword | null): void {
  const tabId = pending?.options.tabId;
  if (!tabId) return;
  updateTab(tabId, (tab) =>
    tab.status === "loading" || tab.status === "unavailable"
      ? {
          ...tab,
          status: "unavailable",
          unavailableDetail: "pdf-password-required",
          updatedAt: Date.now(),
        }
      : tab,
  );
}

function moveTab(
  tabs: WorkspaceRuntimeTab[],
  activeId: string,
  overId: string,
): WorkspaceRuntimeTab[] {
  const from = tabs.findIndex((tab) => tab.id === activeId);
  const to = tabs.findIndex((tab) => tab.id === overId);
  if (from < 0 || to < 0 || from === to) return tabs;
  const next = [...tabs];
  const [moved] = next.splice(from, 1);
  if (!moved) return tabs;
  next.splice(to, 0, moved);
  return next;
}

/** What App owns that changes over time: set by `connect`, read per call. */
type Live = {
  isMobile: boolean;
  pendingPassword: PendingPassword | null;
  setPendingPassword: (pending: PendingPassword | null) => void;
  setTransitioning: (transitioning: boolean) => void;
  flushActiveDraft: () => Promise<void>;
  activeNeedsExport: () => boolean;
};

/**
 * Switching, closing and leaving workspace tabs on the real platform. Created
 * once per window; the step order lives in `planTabActivation` and
 * `src/workspace/tabLifecycle.ts`, where it is tested, and this carries it out.
 */
export function createAppTabs(deps: {
  intake: ColdLoadPorts;
  pdfRuntime: PdfRuntime;
  textSources: ReturnType<typeof createAppTextSources>;
  /** The editor store on screen; set synchronously when the screen changes. */
  activeEditor: () => PdfEditorStoreApi;
  showEditor: (store: PdfEditorStoreApi) => void;
}) {
  const { intake, pdfRuntime, textSources, activeEditor, showEditor } = deps;
  const live: Live = {
    isMobile: false,
    pendingPassword: null,
    setPendingPassword: () => {},
    setTransitioning: () => {},
    flushActiveDraft: async () => {},
    activeNeedsExport: () => false,
  };
  // Closing can await draft/cache writes. Keep those transitions in click
  // order so a later close never publishes state derived from an older tab
  // snapshot and resurrects a tab the reader already closed.
  const enqueueTabClose = createSerialQueue();

  /** Makes `target` the visible tab (or none). */
  function applyActivation(target: WorkspaceRuntimeTab | null): void {
    const residentStore =
      target?.kind === "pdf" ? getTabEditorStore(target.id) : null;
    const steps = planTabActivation(target, {
      resident: residentStore
        ? { baseline: () => exportSnapshotKey(residentStore.getState().model) }
        : null,
      isMobile: live.isMobile,
    });
    for (const step of steps) {
      switch (step.kind) {
        case "setDraftNotices":
          setPendingRestore(step.pending);
          setDeferredDraft(step.deferred);
          setRestoredDraft(step.restored);
          break;
        case "detachEditor":
          emptyPdfEditorStore.getState().closeDocument();
          showEditor(emptyPdfEditorStore);
          break;
        case "hideThumbs":
          residentStore?.getState().setShowThumbs(false);
          break;
        case "publishActiveTab":
          setActiveWorkspaceTabId(step.tabId);
          break;
        case "touchResident":
          touchTabEditorStore(step.tabId);
          break;
        case "attachResident":
          if (residentStore) showEditor(residentStore);
          break;
        case "setExportState":
          setActiveHash(step.hash);
          setExportBaselineSnapshot(step.baseline);
          setLastExport(step.lastExport);
          break;
        case "loadDocument":
          void coldLoadTab(step.tabId, intake);
          break;
      }
    }
  }

  const clearPasswordPrompt = () => {
    makePasswordPromptRetryable(live.pendingPassword);
    live.setPendingPassword(null);
  };

  return {
    activate: (tabId: string) =>
      activateTab(tabId, {
        store: workspaceStore(),
        flushTextSources: textSources.flush,
        persistActivePdf: pdfRuntime.persistLeaving,
        beforeActivate: () => {
          clearPasswordPrompt();
          useAppStore.getState().setError(null);
        },
        applyActivation,
        setTransitioning: (on) => live.setTransitioning(on),
        reportTextSaveFailed: (leaving, error) => {
          console.error("Failed to persist text document before switching tabs", error);
          toast.error(t("documents.textSaveFailed"), leaving?.title);
        },
      }),

    close: (tabId: string) =>
      enqueueTabClose(() =>
        closeTab(tabId, {
          store: workspaceStore(),
          flushTextSources: textSources.flush,
          recordTextRecent,
          discardTextSourceState: textSources.discard,
          flushActiveDraft: () => live.flushActiveDraft(),
          activeNeedsExport: () => live.activeNeedsExport(),
          inactiveNeedsExport: inactiveTabNeedsExport,
          captureActiveDocument: (id) =>
            getTabEditorStore(id)?.getState().opened?.doc ??
            activeEditor().getState().opened?.doc,
          releaseCaches: (closing, remaining) => {
            for (const cacheId of workspaceCacheIdsForTab(closing)) {
              removeWorkspaceSourceIfUnreferenced(cacheId, remaining);
            }
          },
          releaseRuntime: pdfRuntime.release,
          reportTextSaveFailed: (closing, error) => {
            if (error) {
              console.error("Failed to persist text document before closing", error);
            }
            toast.error(t("documents.textSaveFailed"), closing.title);
          },
          reportDraftSaveFailed: (closing, error) => {
            console.error("Failed to persist PDF before closing", error);
            toast.error(t("drafts.saveFailedToast"), closing.title);
          },
          reportClosedUnexported: (closing) =>
            toast.show(t("export.closedUnexported"), closing.title),
          clearPasswordPrompt: () => live.setPendingPassword(null),
          applyActivation,
        }),
      ),

    /** The logo: back to the Landing without closing anything. */
    goHome: () =>
      goHome({
        store: workspaceStore(),
        persistActive: async () => {
          const { activeTabId: tabId, tabs } = workspaceStore().getState();
          const active = tabs.find((tab) => tab.id === tabId);
          if (active?.kind === "pdf") return pdfRuntime.persistLeaving();
          try {
            await textSources.flush(tabId ?? undefined);
            return true;
          } catch (err) {
            console.error(
              "Failed to persist the active document before going home",
              err,
            );
            toast.error(t("documents.textSaveFailed"), active?.title);
            return false;
          }
        },
        recordTextRecent,
        reportTextSaveFailed: () => toast.error(t("documents.textSaveFailed")),
        clearPasswordPrompt,
        applyActivation,
      }),

    reorder(activeId: string, overId: string): void {
      const tabs = workspaceStore().getState().tabs;
      const next = moveTab(tabs, activeId, overId);
      if (next !== tabs) workspaceStore().setState({ tabs: next });
    },

    /**
     * Pinning is explicit and reversible, and it is the only thing that moves
     * a document between the two sections of the navigator's documents view.
     */
    togglePin(id: string): void {
      const next = workspaceStore().getState().tabs.map((tab) =>
        tab.id === id ? { ...tab, pinned: !tab.pinned } : tab,
      );
      workspaceStore().setState({ tabs: next });
    },

    connect(next: Partial<Live>): void {
      Object.assign(live, next);
    },
  };
}

export type AppTabs = ReturnType<typeof createAppTabs>;
