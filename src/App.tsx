import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "./app.css";
import { recordTabPerfRender } from "./perf/tabPerf";
import { ExpiredScreen } from "./editor/components/ExpiredScreen";
import {
  EditorStoreContext,
  emptyPdfEditorStore,
  setActivePdfEditorStoreResolver,
  useAppStore,
  useEditorStore,
  useEditorStoreApi,
  type PdfEditorStoreApi,
} from "./editor/store/store";
import { cleanupTabPreviews } from "./storage/tabPreviews";
import type { LoadedDocumentPayload } from "./documents/types";
import { openDocument } from "./workspace/intake/openDocument";
import { loadActiveTab } from "./workspace/intake/coldLoad";
import type {
  DocumentOpenOptions,
  PendingPassword,
} from "./workspace/intake/types";
import { workspaceCacheIdsForTab } from "./workspace/tabSources";
import { isExpired } from "./runtime/expiry";
import { appVersion } from "./runtime/version";
import drafts from "./storage/drafts";
import { useIsMobile } from "./editor/hooks/useIsMobile";
import { useAppearance } from "./App/hooks/useAppearance";
import { useAutoUpdate } from "./App/hooks/useAutoUpdate";
import { useAppShortcuts } from "./App/hooks/useAppShortcuts";
import { useDocumentIntake } from "./App/hooks/useDocumentIntake";
import { useSuppressBrowserContextMenu } from "./App/hooks/useSuppressBrowserContextMenu";
import { useWorkspacePersistence } from "./App/hooks/useWorkspacePersistence";
import { showAcquireNotice } from "./App/acquireNotices";
import { showMergePickerNotice } from "./App/workspaceNotices";
import { createAppMergePicker } from "./App/mergePickerPorts";
import { createAppNativeMenu } from "./App/nativeMenuPorts";
import { createAppTabs } from "./App/tabLifecyclePorts";
import { createAppPageMerges } from "./App/pageMergePorts";
import { createAppTextSources } from "./App/textSourcePorts";
import { createAppIntake } from "./App/intakePorts";
import { useCanvasWarning } from "./App/hooks/useCanvasWarning";
import { useChangelog } from "./App/hooks/useChangelog";
import { useEncryptedPdfWarning } from "./App/hooks/useEncryptedPdfWarning";
import { useNativeExpiry } from "./App/hooks/useNativeExpiry";
import { useRailLayout } from "./App/hooks/useRailLayout";
import { appPdfRuntime } from "./App/pdfRuntimePorts";
import { ensureRuntimeStorageRepaired } from "./App/workspaceStorage";
import { createAppAcquisition } from "./App/acquisitionPorts";
import { AppScreen } from "./App/render/AppScreen";
import type { PdfDraftControllerApi } from "./App/render/PdfDraftController";
import type { PdfExportControllerApi } from "./App/render/PdfExportController";
import { PdfSessionControllers } from "./App/render/PdfSessionControllers";
import { CAPABILITIES } from "./platform";
import { subscribeToReducedLiveOverlayMotion } from "./live/overlayReveal";
import { toast } from "./editor/toast";
import {
  currentWorkspaceTabs,
  metaFromRuntimeTab,
  useWorkspace,
  workspaceStore,
} from "./workspace/appWorkspace";

export default function App() {
  const [activeEditorStore, setActiveEditorStore] =
    useState<PdfEditorStoreApi>(() => emptyPdfEditorStore);
  const activeEditorStoreRef = useRef(activeEditorStore);
  const getActiveEditorStore = useCallback(
    () => activeEditorStoreRef.current,
    [],
  );
  const activateEditorStore = useCallback((next: PdfEditorStoreApi) => {
    activeEditorStoreRef.current = next;
    setActivePdfEditorStoreResolver(() => activeEditorStoreRef.current);
    setActiveEditorStore(() => next);
  }, []);

  useEffect(() => {
    setActivePdfEditorStoreResolver(() => activeEditorStoreRef.current);
    return () => setActivePdfEditorStoreResolver(null);
  }, []);

  return (
    <EditorStoreContext.Provider value={activeEditorStore}>
      <AppContent
        activateEditorStore={activateEditorStore}
        getActiveEditorStore={getActiveEditorStore}
      />
    </EditorStoreContext.Provider>
  );
}

function AppContent({
  activateEditorStore,
  getActiveEditorStore,
}: {
  activateEditorStore: (store: PdfEditorStoreApi) => void;
  getActiveEditorStore: () => PdfEditorStoreApi;
}) {
  recordTabPerfRender("App");
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const editorStore = useEditorStoreApi();
  const opened = useEditorStore((s) => s.opened);
  // `scale` / `fitMode` are deliberately NOT subscribed here: App uses them
  // only to persist the view state, and a render-level subscription meant
  // every zoom tick re-rendered this entire tree (rail included) — the
  // zoom-flicker bug. PdfViewStatePersister subscribes to them instead.
  const rail = useRailLayout(isMobile);
  const showExport = useAppStore((s) => s.showExport);
  const showSettings = useAppStore((s) => s.showSettings);
  const showShortcuts = useAppStore((s) => s.showShortcuts);
  const showGoToPage = useAppStore((s) => s.showGoToPage);
  const showFind = useAppStore((s) => s.showFind);
  const setShowFind = useAppStore((s) => s.setShowFind);
  const readerMode = useEditorStore((s) => s.readerMode);
  // Theme/appearance application lives in useAppearance.
  const appearance = useAppearance(readerMode);
  // Reduced motion can change while a long Live CLI batch is already queued.
  // Finish it immediately instead of leaving future overlays hidden behind
  // their original animation-delay. One app-level listener avoids a listener
  // (or timer) per overlay and is removed with the root component.
  useEffect(() => {
    if (
      typeof window.matchMedia !== "function"
    ) {
      return;
    }
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    return subscribeToReducedLiveOverlayMotion(media, () => {
      editorStore.setState({
        liveOverlayReveals: [],
        pendingOverlayReveals: new Map(),
      });
    });
  }, [editorStore]);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const insertPdfInputRef = useRef<HTMLInputElement | null>(null);
  const [pdfInsertionBusy, setPdfInsertionBusy] = useState(false);

  // Global keyboard + clipboard shortcuts.
  // Suppress the browser right-click menu on the reader chrome.
  useSuppressBrowserContextMenu();

  const activeHash = useWorkspace((state) => state.session.activeHash);
  const pendingRestore = useWorkspace((state) => state.session.pendingRestore);
  const encryptedPdf = useEncryptedPdfWarning(activeHash, opened?.doc);
  const { encryptedPdfWarningHash } = encryptedPdf;
  const [liveContextTransitioning, setLiveContextTransitioningState] =
    useState(false);
  const [pendingPassword, setPendingPassword] = useState<PendingPassword | null>(null);
  const canvas = useCanvasWarning();
  const { canvasWarning, warnAboutCanvas } = canvas;
  const [nativeExpired, setNativeExpired] = useNativeExpiry();
  const changelog = useChangelog({
    currentVersion: appVersion,
    dev: import.meta.env.DEV,
  });
  const { showChangelog } = changelog;
  const [storageFocusKey, setStorageFocusKey] = useState(0);
  // Self-update lifecycle (startup auto-check + manual check) and the state
  // backing the update modal / Settings feedback.
  const update = useAutoUpdate();
  const { pendingUpdate, runUpdateCheck } = update;
  const folderPaths = useWorkspace((state) => state.folderPaths);
  const tabs = useWorkspace((state) => state.tabs);
  const activeTabId = useWorkspace((state) => state.activeTabId);
  const mountFolderPath = useCallback(
    (picked: string) => workspaceStore().getState().mountFolder(picked),
    [],
  );
  const [hasPendingTextSourceWrites, setHasPendingTextSourceWrites] =
    useState(false);
  useEffect(() => {
    void cleanupTabPreviews(
      new Set(workspaceStore().getState().tabs.map((tab) => tab.id)),
    ).catch((error) => {
      console.warn("Failed to clean stale tab previews", error);
    });
  }, []);

  const setLiveContextTransitioning = useCallback((transitioning: boolean) => {
    setLiveContextTransitioningState(transitioning);
  }, []);

  const draftControllerRef = useRef<PdfDraftControllerApi | null>(null);
  const exportControllerRef = useRef<PdfExportControllerApi | null>(null);
  const flushActiveDraftOrThrow = useCallback(
    () => draftControllerRef.current?.flushNowOrThrow() ?? Promise.resolve(),
    [],
  );

  const [pdfRuntime] = useState(appPdfRuntime);
  const [intake] = useState(createAppIntake);
  const coldLoadPorts = intake.ports;
  const reservePdfResidentCapacity = useCallback(
    (targetTabId: string) =>
      pdfRuntime.reserve(targetTabId, () =>
        toast.error(
          t("documents.runtimeStorageFailed"),
          t("documents.runtimeStorageFailedDetail"),
        ),
      ),
    [pdfRuntime, t],
  );

  const [textSources] = useState(() =>
    createAppTextSources(setHasPendingTextSourceWrites),
  );
  const flushPendingTextSources = textSources.flush;
  useEffect(() => () => textSources.dispose(), [textSources]);

  const persistActivePdfSession = pdfRuntime.persistLeaving;

  const [tabFlows] = useState(() =>
    createAppTabs({
      intake: coldLoadPorts,
      pdfRuntime,
      textSources,
      activeEditor: getActiveEditorStore,
      showEditor: activateEditorStore,
    }),
  );
  useEffect(() => {
    pdfRuntime.connect({
      activeEditor: getActiveEditorStore,
      flushDraft: flushActiveDraftOrThrow,
      discardRefusedEdits: () => draftControllerRef.current?.discardRefusedEdits() ?? false,
      closeDiscardedTab: (tabId) => void tabFlows.close(tabId, { changesDiscarded: true }),
    });
  }, [flushActiveDraftOrThrow, getActiveEditorStore, pdfRuntime, tabFlows]);
  // Before the intake connect below: an open can activate a tab.
  useEffect(() => {
    tabFlows.connect({
      isMobile,
      pendingPassword,
      setPendingPassword,
      setTransitioning: setLiveContextTransitioning,
      flushActiveDraft: flushActiveDraftOrThrow,
      discardRefusedEdits: () => draftControllerRef.current?.discardRefusedEdits() ?? false,
      activeNeedsExport: () =>
        exportControllerRef.current?.status.kind === "needsExport",
    });
  }, [
    flushActiveDraftOrThrow,
    isMobile,
    pendingPassword,
    setLiveContextTransitioning,
    tabFlows,
  ]);
  const activateLoadedTab = tabFlows.activate;

  useEffect(() => {
    if (
      showFind &&
      (showSettings ||
        showExport ||
        showShortcuts ||
        showGoToPage ||
        showChangelog ||
        pendingUpdate ||
        canvasWarning ||
        encryptedPdfWarningHash ||
        pendingRestore ||
        pendingPassword)
    ) {
      setShowFind(false);
    }
  }, [
    canvasWarning,
    encryptedPdfWarningHash,
    pendingPassword,
    pendingRestore,
    pendingUpdate,
    setShowFind,
    showChangelog,
    showExport,
    showFind,
    showGoToPage,
    showSettings,
    showShortcuts,
  ]);

  // One-time cleanup sweep on mount: enforce local draft storage cap.
  useEffect(() => {
    void drafts.cleanup();
    void ensureRuntimeStorageRepaired();
  }, []);

  // Workspace tab persistence lifecycle.
  const reportWorkspacePersistenceFailure = useCallback(() => {
    toast.error(
      t("documents.workspaceSaveFailed"),
      t("documents.workspaceSaveFailedDetail"),
    );
  }, [t]);
  useWorkspacePersistence({
    tabs,
    activeTabId,
    getTabs: currentWorkspaceTabs,
    toMeta: metaFromRuntimeTab,
    cacheIdsForTab: workspaceCacheIdsForTab,
    folderPaths,
    onSaveError: reportWorkspacePersistenceFailure,
  });

  const completeNativeExitRequest = useCallback(
    () =>
      draftControllerRef.current?.completeNativeExitRequest() ??
      Promise.resolve(),
    [],
  );

  const [nativeMenu] = useState(() => createAppNativeMenu(getActiveEditorStore));
  useEffect(() => {
    nativeMenu.connect({
      checkForUpdates: () => void runUpdateCheck(true),
      completeExitRequest: () => void completeNativeExitRequest(),
    });
  }, [nativeMenu, runUpdateCheck, completeNativeExitRequest]);
  useEffect(
    () => (CAPABILITIES.nativeWindowChrome ? nativeMenu.install() : undefined),
    [nativeMenu],
  );

  const [acquisition] = useState(createAppAcquisition);
  // Declared before every effect that can open a document: React runs effects
  // in order, and a launch handoff must find the ports connected.
  useEffect(() => {
    intake.connect({
      isMobile,
      flushTextSources: flushPendingTextSources,
      persistActivePdf: persistActivePdfSession,
      activateLoadedTab,
      activeEditor: getActiveEditorStore,
      showEditor: activateEditorStore,
      reserveResidentSlot: reservePdfResidentCapacity,
      requestPassword: setPendingPassword,
      warnAboutCanvas: () => void warnAboutCanvas(),
      reselectTab: (tabId) => void acquisition.reselectTab(tabId),
    });
  }, [
    acquisition,
    activateEditorStore,
    activateLoadedTab,
    flushPendingTextSources,
    getActiveEditorStore,
    intake,
    isMobile,
    persistActivePdfSession,
    reservePdfResidentCapacity,
    warnAboutCanvas,
  ]);

  const handleDocumentPayload = useCallback(
    (payload: LoadedDocumentPayload, options: DocumentOpenOptions = {}) =>
      openDocument(payload, options, coldLoadPorts),
    [coldLoadPorts],
  );
  // The saved workspace's active tab holds no document at launch. Every later
  // way onto a tab (switch, close, retry) loads it through tab activation.
  useEffect(() => {
    loadActiveTab(coldLoadPorts);
  }, [coldLoadPorts]);

  // Before useDocumentIntake: a Finder "Open with" at launch arrives through
  // its effects, and must find the intake ports connected.
  useEffect(() => {
    acquisition.connect({
      intake: coldLoadPorts,
      clickFileInput: () => fileInputRef.current?.click(),
      notify: (notice) => showAcquireNotice(notice, t),
    });
  }, [acquisition, coldLoadPorts, t]);

  // On desktop Tauri we listen to the native drag-drop event so we can capture
  // the absolute path — our HTML5 `onDrop` handlers only get a File
  // with no path, which would leave a Recent entry no picker can later
  // reopen. The HTML5 handlers early-out on desktop native drag-drop to avoid processing
  // the same bytes twice. Mobile Tauri file intake uses picker/share flows.
  // Platform document-intake listeners: native/web drag-drop, macOS Finder
  // file associations, mobile share/open queue, browser panel nav/open.
  const { openPlatformPath } = useDocumentIntake({
    handleDocumentPayload,
    handleFile: acquisition.openFile,
    handleFolderPath: mountFolderPath,
    setNativeExpired,
  });

  useEffect(() => {
    acquisition.connect({ openPath: openPlatformPath });
  }, [acquisition, openPlatformPath]);

  const [pageMerges] = useState(() => createAppPageMerges(getActiveEditorStore));
  useEffect(() => {
    pageMerges.connect({ flushActiveDraft: flushActiveDraftOrThrow });
  }, [flushActiveDraftOrThrow, pageMerges]);
  useAppShortcuts({
    beginPageMerge: pageMerges.begin,
    saveActiveTextDocument: textSources.saveActive,
  });

  const [mergePicker] = useState(() =>
    createAppMergePicker(pageMerges, getActiveEditorStore, setPdfInsertionBusy),
  );
  useEffect(() => {
    mergePicker.connect({
      clickInput: () => insertPdfInputRef.current?.click(),
      notify: (notice) => showMergePickerNotice(notice, t),
    });
  }, [mergePicker, t]);
  return (
    <PdfSessionControllers
      draftControllerRef={draftControllerRef}
      exportControllerRef={exportControllerRef}
      flushPendingTextSources={flushPendingTextSources}
      hasPendingTextSourceWrites={hasPendingTextSourceWrites}
      transitioning={liveContextTransitioning}
    >
      {nativeExpired || isExpired() ? (
        <ExpiredScreen />
      ) : (
        <AppScreen
          isMobile={isMobile}
          rail={rail}
          appearance={appearance}
          changelog={changelog}
          update={update}
          canvas={canvas}
          encryptedPdf={encryptedPdf}
          tabFlows={tabFlows}
          acquisition={acquisition}
          intake={coldLoadPorts}
          textSources={textSources}
          mergePicker={mergePicker}
          getActiveEditorStore={getActiveEditorStore}
          openPlatformPath={openPlatformPath}
          fileInputRef={fileInputRef}
          insertPdfInputRef={insertPdfInputRef}
          pendingPassword={pendingPassword}
          setPendingPassword={setPendingPassword}
          pdfInsertionBusy={pdfInsertionBusy}
          storageFocusKey={storageFocusKey}
          setStorageFocusKey={setStorageFocusKey}
        />
      )}
    </PdfSessionControllers>
  );
}
