import type { Dispatch, RefObject, SetStateAction } from "react";
import { ErrorScreen } from "../../editor/components/ErrorScreen";
import {
  useAppStore,
  useEditorStore,
  type PdfEditorStoreApi,
} from "../../editor/store/store";
import { useActiveWorkspaceTab } from "../../workspace/appWorkspace";
import type { ColdLoadPorts } from "../../workspace/intake/coldLoad";
import type { PendingPassword } from "../../workspace/intake/types";
import type { AppAcquisition } from "../acquisitionPorts";
import type { useAppearance } from "../hooks/useAppearance";
import type { useAutoUpdate } from "../hooks/useAutoUpdate";
import type { useCanvasWarning } from "../hooks/useCanvasWarning";
import type { useChangelog } from "../hooks/useChangelog";
import type { useEncryptedPdfWarning } from "../hooks/useEncryptedPdfWarning";
import type { useRailLayout } from "../hooks/useRailLayout";
import type { AppMergePicker } from "../mergePickerPorts";
import type { AppTabs } from "../tabLifecyclePorts";
import type { AppTextSources } from "../textSourcePorts";
import { openPickedFiles } from "./fileInput";
import { PasswordPrompt } from "./PasswordPrompt";
import {
  DocumentPicker,
  HomeScreen,
  WindowOverlays,
  type WindowOverlayProps,
} from "./WindowOverlays";
import { WorkspaceScreen } from "./WorkspaceScreen";

/**
 * What App owns and the screens read. The hooks stay in App so their effects
 * outlive whichever screen is showing; the ports are created once per window
 * and connected from App's effects; the refs are clicked from those ports.
 */
export type AppScreenProps = {
  isMobile: boolean;
  rail: ReturnType<typeof useRailLayout>;
  appearance: ReturnType<typeof useAppearance>;
  changelog: ReturnType<typeof useChangelog>;
  update: ReturnType<typeof useAutoUpdate>;
  canvas: ReturnType<typeof useCanvasWarning>;
  encryptedPdf: ReturnType<typeof useEncryptedPdfWarning>;
  tabFlows: AppTabs;
  acquisition: AppAcquisition;
  intake: ColdLoadPorts;
  textSources: AppTextSources;
  mergePicker: AppMergePicker;
  /** The editor store on screen, read at call time. */
  getActiveEditorStore: () => PdfEditorStoreApi;
  openPlatformPath: (path: string) => Promise<void>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  insertPdfInputRef: RefObject<HTMLInputElement | null>;
  pendingPassword: PendingPassword | null;
  setPendingPassword: (next: PendingPassword | null) => void;
  pdfInsertionBusy: boolean;
  storageFocusKey: number;
  setStorageFocusKey: Dispatch<SetStateAction<number>>;
};

/** An error, home, or the workspace, each with the window's own dialogs. */
export function AppScreen(props: AppScreenProps) {
  const {
    acquisition,
    changelog,
    fileInputRef,
    intake,
    pendingPassword,
    setPendingPassword,
    storageFocusKey,
    update,
  } = props;
  const opened = useEditorStore((s) => s.opened);
  const showSettings = useAppStore((s) => s.showSettings);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const showShortcuts = useAppStore((s) => s.showShortcuts);
  const setShowShortcuts = useAppStore((s) => s.setShowShortcuts);
  const errorInfo = useAppStore((s) => s.errorInfo);
  const setError = useAppStore((s) => s.setError);
  const activeTab = useActiveWorkspaceTab();
  const onPickerChange = openPickedFiles(acquisition.openFiles);

  const passwordDialog = (
    <PasswordPrompt
      pendingPassword={pendingPassword}
      setPendingPassword={setPendingPassword}
      intake={intake}
    />
  );

  const overlayProps: WindowOverlayProps = {
    showSettings,
    closeSettings: () => setShowSettings(false),
    storageFocusKey,
    updateCheckState: update.updateCheckState,
    updateCheckError: update.updateCheckError,
    checkForUpdates: () => {
      void update.runUpdateCheck(true);
    },
    showShortcuts,
    closeShortcuts: () => setShowShortcuts(false),
    showChangelog: changelog.showChangelog,
    openChangelog: changelog.openChangelog,
    closeChangelog: changelog.closeChangelog,
    pendingUpdate: update.pendingUpdate,
    dismissUpdate: () => update.setPendingUpdate(null),
    fileInputRef,
    onPickerChange,
    passwordDialog,
  };

  if (errorInfo) {
    return (
      <>
        <ErrorScreen
          info={errorInfo}
          onRetry={() => {
            setError(null);
            void acquisition.pick();
          }}
          onDismiss={() => setError(null)}
        />
        <DocumentPicker inputRef={fileInputRef} onChange={onPickerChange} />
        {passwordDialog}
      </>
    );
  }

  if (!opened && !activeTab) {
    return (
      <HomeScreen
        {...overlayProps}
        onOpen={acquisition.pick}
        onReopen={acquisition.reopenRecent}
      />
    );
  }

  return (
    <WorkspaceScreen
      {...props}
      tab={activeTab}
      overlays={<WindowOverlays {...overlayProps} />}
    />
  );
}
