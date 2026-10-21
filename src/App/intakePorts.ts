import {
  attachRecentThumb,
  canReopenRecent,
  forgetRecent,
  getRecent,
  getRecentLastPage,
  recordRecent,
  replaceRecent,
} from "../editor/recentDocs";
import {
  emptyPdfEditorStore,
  useAppStore,
  type PdfEditorStoreApi,
} from "../editor/store/store";
import {
  ensureTabEditorStore,
  getTabEditorStore,
  removeTabEditorStore,
  touchTabEditorStore,
} from "../editor/store/tabStoreRegistry";
import { toast } from "../editor/toast";
import { prefersReducedLiveOverlayMotion } from "../live/overlayReveal";
import { appPdfEngine } from "../pdf/engine/appEngine";
import { MAX_PDF_BYTES, MAX_PDF_PAGES } from "../pdf/openPolicy";
import { CAPABILITIES } from "../platform";
import { claimDraft } from "../storage/draftClaim";
import drafts from "../storage/drafts";
import { readOperationLog } from "../storage/operationLog";
import {
  forgetWebFileHandle,
  webFileHandleExists,
} from "../storage/recentFileHandles";
import {
  readRuntimeSession,
  rememberRuntimeCredential,
  removeRuntimeSession,
  runtimeCredential,
} from "../storage/runtimeSessions";
import { getWorkspaceSource } from "../storage/workspace";
import { formatBytes } from "../shared/format";
import { createSerialQueue } from "../shared/serialQueue";
import { workspaceStore } from "../workspace/appWorkspace";
import { markSupersededLoad, type ColdLoadPorts } from "../workspace/intake/coldLoad";
import { readTabSource } from "../workspace/intake/readTabSource";
import type { PendingPassword } from "../workspace/intake/types";
import { buildOpenErrorInfo, showDocumentOpenPolicyError } from "./openErrors";
import { describeRestoreError } from "./render/restoreError";
import { recordTextRecent } from "./textRecents";
import { translate as t } from "./translate";
import {
  ensureRuntimeStorageRepaired,
  ensureWorkspaceSource,
  removeWorkspaceSourceIfUnreferenced,
} from "./workspaceStorage";

/** Live overlay reveals play unless the reader turned them off, in either place. */
export function animateOverlays(): boolean {
  return (
    useAppStore.getState().prefs.annotationAnimations &&
    !prefersReducedLiveOverlayMotion()
  );
}

/** What App owns that changes over time: set by `connect`, read per call. */
type Live = {
  isMobile: boolean;
  flushTextSources: (tabId?: string) => Promise<void>;
  persistActivePdf: () => Promise<boolean>;
  activateLoadedTab: (tabId: string) => Promise<void>;
  activeEditor: () => PdfEditorStoreApi;
  showEditor: (store: PdfEditorStoreApi) => void;
  reserveResidentSlot: (tabId: string) => Promise<boolean>;
  requestPassword: (pending: PendingPassword) => void;
  warnAboutCanvas: () => void;
  reselectTab: (tabId: string) => void;
};

class IntakeNotConnected extends Error {
  constructor() {
    super("intake-not-connected");
  }
}

const notConnected = () => {
  throw new IntakeNotConnected();
};

/**
 * The open pipeline's ports on the real platform, created once per window.
 * App connects what it owns from an effect declared before any effect that
 * can open a document (React runs effects in declaration order), so a launch
 * handoff never meets unconnected ports.
 */
export function createAppIntake() {
  const live: Live = {
    isMobile: false,
    flushTextSources: notConnected,
    persistActivePdf: notConnected,
    activateLoadedTab: notConnected,
    activeEditor: () => emptyPdfEditorStore,
    showEditor: notConnected,
    reserveResidentSlot: notConnected,
    requestPassword: notConnected,
    warnAboutCanvas: () => {},
    reselectTab: () => {},
  };
  // PDF opens and cold LRU resumes share the resident registry and suspended
  // session rows. Keep their admission/finalization phases serialized so a
  // rapid second tab click cannot evict a store while the first resume is
  // still consuming its durable row.
  const enqueuePdfOpen = createSerialQueue();

  const ports: ColdLoadPorts = {
    store: workspaceStore(),
    engine: appPdfEngine,
    enqueuePdfOpen,
    settings: () => ({
      compactLayout: live.isMobile,
      animateOverlays: animateOverlays(),
    }),
    persistActive: async () => {
      try {
        await live.flushTextSources(
          workspaceStore().getState().activeTabId ?? undefined,
        );
      } catch (err) {
        // An unconnected port is a wiring bug, not a failed text save.
        if (err instanceof IntakeNotConnected) throw err;
        console.error("Failed to persist text before opening a document", err);
        toast.error(t("documents.textSaveFailed"));
        return false;
      }
      return live.persistActivePdf();
    },
    activateLoadedTab: (tabId) => live.activateLoadedTab(tabId),
    markSuperseded: markSupersededLoad,
    sources: {
      ensure: ensureWorkspaceSource,
      get: getWorkspaceSource,
      removeIfUnreferenced: (cacheId) =>
        void removeWorkspaceSourceIfUnreferenced(cacheId),
    },
    drafts: {
      claim: (hash, draftId) =>
        claimDraft(hash, draftId, { webFileHandleExists }),
      get: (draftId) => drafts.get(draftId),
      getLiveOperationReceipts: (hash) => drafts.getLiveOperationReceipts(hash),
      mergeLiveOperationReceipts: (hash, ids) =>
        drafts.mergeLiveOperationReceipts(hash, ids),
      readOperationLog,
    },
    editors: {
      get: getTabEditorStore,
      ensure: ensureTabEditorStore,
      remove: removeTabEditorStore,
      touch: touchTabEditorStore,
      show: (store) => live.showEditor(store),
      detach: () => {
        emptyPdfEditorStore.getState().closeDocument();
        live.showEditor(emptyPdfEditorStore);
      },
      hasOpenDocument: () => Boolean(live.activeEditor().getState().opened),
      reserveResidentSlot: (tabId) => live.reserveResidentSlot(tabId),
    },
    runtime: {
      removeSession: removeRuntimeSession,
      rememberCredential: rememberRuntimeCredential,
    },
    recents: {
      list: getRecent,
      canReopen: (entry) =>
        canReopenRecent(
          entry,
          CAPABILITIES.nativePaths,
          CAPABILITIES.workspaceSourceCache,
        ),
      record: (entry) => void recordRecent(entry),
      replace: (previous, entry) => void replaceRecent(previous, entry),
      forget: forgetRecent,
      forgetWebFileHandle: (id) => void forgetWebFileHandle(id),
      attachThumb: attachRecentThumb,
      recordText: recordTextRecent,
      lastPage: getRecentLastPage,
    },
    ui: {
      setError: (info) => useAppStore.getState().setError(info),
      requestPassword: (pending) => live.requestPassword(pending),
      warnAboutCanvas: () => live.warnAboutCanvas(),
      describeOpenError: (name, size, error) =>
        buildOpenErrorInfo(
          name,
          size,
          error,
          t,
          formatBytes(MAX_PDF_BYTES),
          MAX_PDF_PAGES,
        ),
      toastError: (title, detail) => toast.error(title, detail),
      reportDocumentPolicyError: (error, name, kind) =>
        showDocumentOpenPolicyError(error, name, kind, t),
      reportWorkingCopyMissing: (name) =>
        toast.error(t("documents.workingCopyMissing"), name),
    },
    readTabSource,
    readRuntimeSession,
    storageRepaired: ensureRuntimeStorageRepaired,
    credential: runtimeCredential,
    reportRestoreFailed: (tab, detail) =>
      toast.errorAction(
        t("tabs.restoreFailed"),
        {
          label:
            tab.source.type === "webFileHandle"
              ? t("tabs.restoreAuthorize")
              : t("tabs.restorePickAgain"),
          onClick: () => live.reselectTab(tab.id),
        },
        `${tab.title} · ${describeRestoreError(detail, t)}`,
      ),
  };

  return {
    ports,
    connect(next: Partial<Live>): void {
      Object.assign(live, next);
    },
  };
}

export type AppIntake = ReturnType<typeof createAppIntake>;
