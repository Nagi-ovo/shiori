import type { ChangeEvent, ReactNode, RefObject } from "react";
import {
  DOCUMENT_INPUT_ACCEPT,
  PDF_INPUT_ACCEPT,
} from "../../documents/types";
// Deferred: loaded on first open, kept out of the entry bundle.
import {
  ChangelogModal,
  SettingsPanel,
  UpdateModal,
} from "../../editor/components/deferredModals";
import { Landing } from "../../editor/components/Landing";
import { ShortcutsSheet } from "../../editor/components/ShortcutsSheet";
import { ToastHost } from "../../editor/components/ToastHost";
import type { RecentEntry } from "../../editor/recentDocs";
import { CAPABILITIES } from "../../platform";
import type { useAutoUpdate } from "../hooks/useAutoUpdate";
import { FILE_INPUT_A11Y, FILE_INPUT_STYLE } from "./fileInput";

const DOCUMENT_ACCEPT = CAPABILITIES.textDocuments
  ? DOCUMENT_INPUT_ACCEPT
  : PDF_INPUT_ACCEPT;

/** The hidden multi-select document input behind every Open button. */
export function DocumentPicker({
  inputRef,
  onChange,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <input
      ref={inputRef}
      type="file"
      accept={DOCUMENT_ACCEPT}
      multiple
      style={FILE_INPUT_STYLE}
      {...FILE_INPUT_A11Y}
      onChange={onChange}
    />
  );
}

type Update = ReturnType<typeof useAutoUpdate>;

/** The window's own dialogs, whichever screen is showing. */
export type WindowOverlayProps = {
  showSettings: boolean;
  closeSettings: () => void;
  storageFocusKey: number;
  updateCheckState: Update["updateCheckState"];
  updateCheckError: Update["updateCheckError"];
  checkForUpdates: () => void;
  showShortcuts: boolean;
  closeShortcuts: () => void;
  showChangelog: boolean;
  openChangelog: () => void;
  closeChangelog: () => void;
  pendingUpdate: Update["pendingUpdate"];
  dismissUpdate: () => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onPickerChange: (event: ChangeEvent<HTMLInputElement>) => void;
  passwordDialog: ReactNode;
};

function Settings(props: WindowOverlayProps) {
  return (
    <SettingsPanel
      open={props.showSettings}
      storageFocusKey={props.storageFocusKey}
      onClose={props.closeSettings}
      updateCheckState={props.updateCheckState}
      updateCheckError={props.updateCheckError}
      onCheckForUpdates={props.checkForUpdates}
      onOpenChangelog={props.openChangelog}
    />
  );
}

function Changelog(props: WindowOverlayProps) {
  return props.showChangelog ? <ChangelogModal onClose={props.closeChangelog} /> : null;
}

function Update(props: WindowOverlayProps) {
  return props.pendingUpdate ? (
    <UpdateModal update={props.pendingUpdate} onClose={props.dismissUpdate} />
  ) : null;
}

/**
 * Below an open document. These hosts belong to the application window, not
 * to a document format; one node keeps every kind wired to the same UI.
 */
export function WindowOverlays(props: WindowOverlayProps) {
  return (
    <>
      <Settings {...props} />
      <ShortcutsSheet open={props.showShortcuts} onClose={props.closeShortcuts} />
      <Changelog {...props} />
      <Update {...props} />
      <ToastHost />
      <DocumentPicker inputRef={props.fileInputRef} onChange={props.onPickerChange} />
      {props.passwordDialog}
    </>
  );
}

/** The home screen, with the window's dialogs in its own stacking order. */
export function HomeScreen({
  onOpen,
  onReopen,
  ...props
}: WindowOverlayProps & {
  onOpen: (file?: File) => Promise<void>;
  onReopen: (entry: RecentEntry) => Promise<boolean>;
}) {
  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* No tab strip on the landing: the home screen stays a clean start
          page and the Recent list is the way back to open work. Tabs persist
          in memory and reappear once a document opens. */}
      <Landing onOpen={onOpen} onReopen={onReopen} onOpenChangelog={props.openChangelog} />
      <Changelog {...props} />
      <Update {...props} />
      {/* Shortcuts sheet has to live on the home screen too — otherwise ⌘/
          flips `showShortcuts` but the panel isn't mounted, so the overlay
          only appears later when the user opens a PDF and the editor branch
          finally renders it. */}
      <ShortcutsSheet open={props.showShortcuts} onClose={props.closeShortcuts} />
      {/* Same rule as the shortcuts sheet, twice over: the native menu's
          Settings item (⌘,) flips `showSettings` from any screen, and toasts
          fire from the landing's own flows (a Recent entry whose file is
          gone, draft save failures during open). Neither had a mount here,
          so settings silently queued until a document opened and toasts on
          the landing vanished outright. */}
      <Settings {...props} />
      <ToastHost />
      <DocumentPicker inputRef={props.fileInputRef} onChange={props.onPickerChange} />
      {props.passwordDialog}
    </div>
  );
}
