import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import { PDF_INPUT_ACCEPT } from "../../documents/types";
import { PageIndicatorPill } from "../../editor/components/PageIndicatorPill";
import { ToastHost } from "../../editor/components/ToastHost";
import { type ExportedSnapshot } from "../../editor/export/exportStatus";
import { useAppStore, useEditorStore } from "../../editor/store/store";
import type { PdfDocument } from "../../pdf/engine/types";
import { CAPABILITIES } from "../../platform";
import { WINDOW_CAPTION_HEIGHT } from "../../platform/windowCaption";
import drafts from "../../storage/drafts";
import { clearOperationLog } from "../../storage/operationLog";
import {
  setLastExport,
  updateTab,
  useWorkspace,
  workspaceStore,
} from "../../workspace/appWorkspace";
import {
  deferDraft,
  discardDraft,
  openOriginal,
  restoreDraft,
  type DraftDecisionPorts,
} from "../../workspace/draftDecisions";
import type { WorkspaceRuntimeTab } from "../../workspace/types";
import { AppDialogs } from "./AppDialogs";
import type { AppScreenProps } from "./AppScreen";
import { FILE_INPUT_A11Y, FILE_INPUT_STYLE, openPickedFiles } from "./fileInput";
import { MobilePdfChromeToggle } from "./MobilePdfChromeToggle";
import { PasswordPrompt } from "./PasswordPrompt";
import { PdfDraftStatusBar } from "./PdfDraftController";
import { PdfViewStatePersister, RecentPdfPagePersister } from "./persisters";
import { DocumentPicker } from "./WindowOverlays";

type Props = Pick<
  AppScreenProps,
  | "isMobile"
  | "changelog"
  | "update"
  | "canvas"
  | "encryptedPdf"
  | "acquisition"
  | "intake"
  | "mergePicker"
  | "getActiveEditorStore"
  | "openPlatformPath"
  | "fileInputRef"
  | "insertPdfInputRef"
  | "pendingPassword"
  | "setPendingPassword"
  | "storageFocusKey"
  | "setStorageFocusKey"
> & {
  tab: WorkspaceRuntimeTab | null;
  doc: PdfDocument;
  /** The top safe-area inset the reader-mode exit button clears. */
  readerModeSafeTop: string;
};

/**
 * Below an open PDF's document row: the view-state persisters, the
 * reader-mode exit, the draft status bar, the dialogs, toasts and the hidden
 * pickers. Only mounted with an open PDF, so `doc` is always present.
 */
export function PdfOverlays({
  isMobile,
  changelog,
  update,
  canvas,
  encryptedPdf,
  acquisition,
  intake,
  mergePicker,
  getActiveEditorStore,
  openPlatformPath,
  fileInputRef,
  insertPdfInputRef,
  pendingPassword,
  setPendingPassword,
  storageFocusKey,
  setStorageFocusKey,
  tab,
  doc,
  readerModeSafeTop,
}: Props) {
  const { t } = useTranslation();
  const readerMode = useEditorStore((s) => s.readerMode);
  const setReaderMode = useEditorStore((s) => s.setReaderMode);
  const showExport = useAppStore((s) => s.showExport);
  const setShowExport = useAppStore((s) => s.setShowExport);
  const showSettings = useAppStore((s) => s.showSettings);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const showShortcuts = useAppStore((s) => s.showShortcuts);
  const setShowShortcuts = useAppStore((s) => s.setShowShortcuts);
  const showGoToPage = useAppStore((s) => s.showGoToPage);
  const setShowGoToPage = useAppStore((s) => s.setShowGoToPage);
  const showFind = useAppStore((s) => s.showFind);
  const setShowFind = useAppStore((s) => s.setShowFind);
  const activeHash = useWorkspace((state) => state.session.activeHash);
  const activeTabId = useWorkspace((state) => state.activeTabId);
  const pendingRestore = useWorkspace((state) => state.session.pendingRestore);
  const deferredDraft = useWorkspace((state) => state.session.deferredDraft);
  const restoredDraft = useWorkspace((state) => state.session.restoredDraft);

  const markExportSaved = useCallback(
    (result: {
      path: string;
      platform: "desktop" | "web" | "mobile";
      completeDocument: boolean;
      snapshotKey: string;
    }) => {
      if (!activeHash || !result.completeDocument) return;
      const next: ExportedSnapshot = {
        documentHash: activeHash,
        snapshotKey: result.snapshotKey,
        exportedAt: Date.now(),
        path: result.path,
        platform: result.platform,
      };
      setLastExport(next);
      // Write it straight to the tab too. persistActivePdfSession is the only
      // other writer and it runs on tab switch — so a reader who exports and
      // then quits without ever switching tabs had nothing persisted, and the
      // next launch called the document unexported: dirty dot still lit, and
      // a bogus "closed without exporting" warning on close. Warnings that
      // cry wolf stop being read, which defeats the point of tracking this.
      if (activeTabId) {
        updateTab(activeTabId, (tab) => ({
          ...tab,
          hash: activeHash ?? tab.hash,
          lastExport: next,
          updatedAt: Date.now(),
        }));
      }
    },
    [activeHash, activeTabId],
  );

  const draftPorts: DraftDecisionPorts = {
    store: workspaceStore(),
    editor: getActiveEditorStore,
    removeDraft: (draftId) => {
      void drafts.removeDraftPreservingLiveOperationReceipts(draftId);
      clearOperationLog(draftId);
    },
  };

  // The exit button floats in the top-right corner, which on Windows belongs
  // to the caption buttons; drop below them there.
  const exitTop = `calc(${
    14 + (CAPABILITIES.customWindowCaption ? WINDOW_CAPTION_HEIGHT : 0)
  }px + ${readerModeSafeTop})`;

  return (
    <>
      <PdfViewStatePersister
        activeHash={activeHash}
        activeTabId={activeTabId}
        activeTabKind={tab?.kind}
      />
      <RecentPdfPagePersister
        activeSource={tab?.kind === "pdf" ? tab.source : null}
      />
      {isMobile && readerMode ? (
        <MobilePdfChromeToggle
          collapsed
          fixed
          topInset={exitTop}
          onClick={() => setReaderMode(false)}
        />
      ) : readerMode ? (
        <button
          type="button"
          onClick={() => setReaderMode(false)}
          title={t("nav.readerModeExit")}
          aria-label={t("nav.readerModeExit")}
          style={{
            position: "fixed",
            top: exitTop,
            right: "calc(14px + var(--shiori-safe-right, 0px))",
            width: 44,
            height: 44,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            border: `1px solid ${T.rule}`,
            background: T.cream,
            color: T.ink2,
            borderRadius: 999,
            cursor: "pointer",
            padding: 0,
            zIndex: 50,
            boxShadow: "0 6px 18px rgba(20,16,10,0.18)",
            opacity: 0.9,
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      ) : null}
      {/* Phones have no status bar to read the page number off; the
          pill floats over the document while scrolling instead. Same
          reader-mode guard as the bar it replaces — reader mode has
          never shown a page readout. */}
      {readerMode ? null : <PageIndicatorPill />}
      {readerMode ? null : (
        <PdfDraftStatusBar
          onOpenStorage={() => {
            setStorageFocusKey((n) => n + 1);
            setShowSettings(true);
          }}
          restoredDraft={
            restoredDraft
              ? {
                  committedModel: restoredDraft.committedModel,
                  lastTouched: restoredDraft.draft.lastTouched,
                }
              : null
          }
          draftSetAside={deferredDraft !== null && pendingRestore === null}
          onOpenOriginal={() => openOriginal(draftPorts)}
          onRestoreSetAsideDraft={() => restoreDraft(draftPorts)}
        />
      )}
      <AppDialogs
        showChangelog={changelog.showChangelog}
        closeChangelog={changelog.closeChangelog}
        openChangelog={changelog.openChangelog}
        canvasWarning={canvas.canvasWarning}
        closeCanvasWarning={canvas.closeCanvasWarning}
        retryCanvasWarning={canvas.retryCanvasWarning}
        showEncryptedPdfWarning={
          encryptedPdf.encryptedPdfWarningHash !== null &&
          encryptedPdf.encryptedPdfWarningHash === activeHash
        }
        closeEncryptedPdfWarning={encryptedPdf.closeEncryptedPdfWarning}
        restrictedPdfEdits={encryptedPdf.restricted}
        showExport={showExport}
        setShowExport={setShowExport}
        markExportSaved={markExportSaved}
        openPlatformPath={openPlatformPath}
        showSettings={showSettings}
        setShowSettings={setShowSettings}
        storageFocusKey={storageFocusKey}
        updateCheckState={update.updateCheckState}
        updateCheckError={update.updateCheckError}
        runUpdateCheck={update.runUpdateCheck}
        pendingUpdate={update.pendingUpdate}
        setPendingUpdate={update.setPendingUpdate}
        showShortcuts={showShortcuts}
        setShowShortcuts={setShowShortcuts}
        showGoToPage={showGoToPage}
        setShowGoToPage={setShowGoToPage}
        doc={doc}
        showFind={showFind}
        setShowFind={setShowFind}
        pendingRestore={pendingRestore}
        onRestoreDraft={() => restoreDraft(draftPorts)}
        onDeferDraft={() => deferDraft(draftPorts)}
        onDiscardDraft={() => discardDraft(draftPorts)}
      />
      <ToastHost />
      <DocumentPicker
        inputRef={fileInputRef}
        onChange={openPickedFiles(acquisition.openFiles)}
      />
      <input
        ref={insertPdfInputRef}
        type="file"
        accept={PDF_INPUT_ACCEPT}
        style={FILE_INPUT_STYLE}
        {...FILE_INPUT_A11Y}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          mergePicker.fromInput(file);
        }}
      />
      <PasswordPrompt
        pendingPassword={pendingPassword}
        setPendingPassword={setPendingPassword}
        intake={intake}
      />
    </>
  );
}
