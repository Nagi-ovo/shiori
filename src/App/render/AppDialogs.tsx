import type { ComponentProps, Dispatch, SetStateAction } from "react";

import { CanvasCapabilityDialog } from "../../editor/components/CanvasCapabilityDialog";
import { ExportDialog } from "../../editor/components/ExportDialog";
import { EncryptedPdfWarningDialog } from "../../editor/components/EncryptedPdfWarningDialog";
import { FindPanel } from "../../editor/components/FindPanel";
import { GoToPageDialog } from "../../editor/components/GoToPageDialog";
import { RestoreDraftDialog } from "../../editor/components/RestoreDraftDialog";
import { ShortcutsSheet } from "../../editor/components/ShortcutsSheet";
// Deferred: loaded on first open, kept out of the entry bundle.
import {
  ChangelogModal,
  SettingsPanel,
  UpdateModal,
} from "../../editor/components/deferredModals";
import type { UpdateCheckState } from "../hooks/useAutoUpdate";
import type { ShioriUpdate } from "../../platform";
import type { CanvasCapabilityReport } from "../../platform/canvasCapabilities";
import type { PdfDocument } from "../../pdf/engine/types";
import { useEditorStore } from "../../editor/store/store";
import { draftConflictChoice } from "../draftConflictChoice";
import { DraftConflictDialog } from "./DraftConflictDialog";
import type { PdfEditKind } from "../../pdf/security/permissions";

type AppDialogsProps = {
  showChangelog: boolean;
  closeChangelog: () => void;
  openChangelog: () => void;
  canvasWarning: CanvasCapabilityReport | null;
  closeCanvasWarning: () => void;
  retryCanvasWarning: () => Promise<boolean>;
  showEncryptedPdfWarning: boolean;
  closeEncryptedPdfWarning: () => void;
  restrictedPdfEdits: readonly PdfEditKind[];
  showExport: boolean;
  setShowExport: (v: boolean) => void;
  markExportSaved: NonNullable<
    ComponentProps<typeof ExportDialog>["onExportSaved"]
  >;
  openPlatformPath: (path: string) => Promise<void>;
  showSettings: boolean;
  setShowSettings: (v: boolean) => void;
  storageFocusKey: number;
  updateCheckState: UpdateCheckState;
  updateCheckError: string | null;
  runUpdateCheck: (manual: boolean) => Promise<void>;
  pendingUpdate: ShioriUpdate | null;
  setPendingUpdate: Dispatch<SetStateAction<ShioriUpdate | null>>;
  showShortcuts: boolean;
  setShowShortcuts: (v: boolean) => void;
  showGoToPage: boolean;
  setShowGoToPage: (v: boolean) => void;
  doc: PdfDocument;
  showFind: boolean;
  setShowFind: (v: boolean) => void;
  pendingRestore: { file: { name: string }; lastTouched: number } | null;
  onRestoreDraft: () => void;
  onDeferDraft: () => void;
  onDiscardDraft: () => void;
};

/**
 * The overlay dialog cluster rendered near the end of the App main
 * (document-panel) branch. Pure JSX
 * relocation — each dialog's open-state, handlers, and data are threaded
 * verbatim through props, so there is no behavior change. Only mounted from
 * the main editor branch (past App's `if (!opened) return`), so FindPanel's
 * `doc` (App's `opened.doc`) is always present here.
 */
export function AppDialogs({
  showChangelog,
  closeChangelog,
  openChangelog,
  canvasWarning,
  closeCanvasWarning,
  retryCanvasWarning,
  showEncryptedPdfWarning,
  closeEncryptedPdfWarning,
  restrictedPdfEdits,
  showExport,
  setShowExport,
  markExportSaved,
  openPlatformPath,
  showSettings,
  setShowSettings,
  storageFocusKey,
  updateCheckState,
  updateCheckError,
  runUpdateCheck,
  pendingUpdate,
  setPendingUpdate,
  showShortcuts,
  setShowShortcuts,
  showGoToPage,
  setShowGoToPage,
  doc,
  showFind,
  setShowFind,
  pendingRestore,
  onRestoreDraft,
  onDeferDraft,
  onDiscardDraft,
}: AppDialogsProps) {
  const pages = useEditorStore((state) => state.model.pages);
  const opened = useEditorStore((state) => state.opened);
  return (
    <>
      {showChangelog ? <ChangelogModal onClose={closeChangelog} /> : null}
      {canvasWarning ? (
        <CanvasCapabilityDialog
          report={canvasWarning}
          onClose={closeCanvasWarning}
          onRetry={retryCanvasWarning}
        />
      ) : null}
      <EncryptedPdfWarningDialog
        open={showEncryptedPdfWarning}
        fileName={opened?.fileName ?? ""}
        restricted={restrictedPdfEdits}
        onClose={closeEncryptedPdfWarning}
      />

      <DraftConflictDialog
        choice={draftConflictChoice}
        fileName={opened?.fileName ?? ""}
        onExport={() => setShowExport(true)}
      />
      <ExportDialog
        open={showExport}
        onClose={() => setShowExport(false)}
        onExportSaved={markExportSaved}
        onOpenExported={(path) => {
          void openPlatformPath(path);
        }}
      />
      <SettingsPanel
        open={showSettings}
        storageFocusKey={storageFocusKey}
        onClose={() => setShowSettings(false)}
        updateCheckState={updateCheckState}
        updateCheckError={updateCheckError}
        onCheckForUpdates={() => {
          void runUpdateCheck(true);
        }}
        onOpenChangelog={openChangelog}
      />
      {pendingUpdate ? (
        <UpdateModal
          update={pendingUpdate}
          onClose={() => setPendingUpdate(null)}
        />
      ) : null}
      <ShortcutsSheet
        open={showShortcuts}
        onClose={() => setShowShortcuts(false)}
      />
      {showGoToPage ? (
        <GoToPageDialog onClose={() => setShowGoToPage(false)} />
      ) : null}
      <FindPanel
        doc={doc}
        pages={pages}
        open={showFind}
        onClose={() => setShowFind(false)}
      />
      {pendingRestore ? (
        <RestoreDraftDialog
          open
          fileName={pendingRestore.file.name}
          lastTouched={pendingRestore.lastTouched}
          onRestore={onRestoreDraft}
          onCancel={onDeferDraft}
          onDiscard={onDiscardDraft}
        />
      ) : null}
    </>
  );
}
