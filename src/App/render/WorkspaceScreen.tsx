import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ContextualToolbar } from "../../editor/components/ContextualToolbar";
import { documentIdentityRow } from "../../editor/components/documentIdentityRow";
import { pdfDocumentRowStyle } from "../../editor/components/documentRowLayout";
import { WorkspaceSwitcher } from "../../editor/components/WorkspaceSwitcher";
import { useIsPhone } from "../../editor/hooks/useIsMobile";
import { useAppStore, useEditorStore } from "../../editor/store/store";
import { requestPrint } from "../../editor/viewport/requestPrint";
import { CAPABILITIES, IS_ANDROID, IS_IOS, IS_MAC } from "../../platform";
import { WINDOW_CAPTION_HEIGHT } from "../../platform/windowCaption";
import { formatBytes } from "../../shared/format";
import { updateTab, useWorkspace } from "../../workspace/appWorkspace";
import { coldLoadTab } from "../../workspace/intake/coldLoad";
import type { WorkspaceRuntimeTab } from "../../workspace/types";
import { switcherItems, tabStripItems, requestTabPreview } from "../workspaceLists";
import type { AppScreenProps } from "./AppScreen";
import { DocumentLoadingState } from "./DocumentLoadingState";
import { DocxViewport } from "./DocxViewport";
import { PdfExportAwareTabStrip } from "./PdfExportController";
import { PdfOverlays } from "./PdfOverlays";
import { PdfViewport } from "./PdfViewport";
import { TextViewport } from "./TextViewport";
import { WorkspaceNavigator } from "./WorkspaceNavigator";
import {
  WorkspaceView,
  type OpenPdfView,
  type WorkspaceChrome,
  type WorkspaceViewports,
} from "./WorkspaceView";

const readerModeSafeTop =
  IS_IOS || IS_ANDROID ? "var(--shiori-safe-top, 0px)" : "0px";

function buildMeta(size: number, pages: number, ppAbbr: string): string {
  const mb = formatBytes(size);
  return `${pages} ${ppAbbr} · ${mb}`;
}

/**
 * The workspace: the shared chrome, each kind's viewport and, for an open
 * PDF, its own chrome and overlays, handed to the one `WorkspaceView`. The
 * choice between document kinds is made below the view, never above it, so
 * the rail stays one DOM node across a switch.
 */
export function WorkspaceScreen({
  tab,
  overlays,
  ...props
}: AppScreenProps & {
  tab: WorkspaceRuntimeTab | null;
  /** The window's dialogs, toasts and pickers, below a non-PDF document. */
  overlays: ReactNode;
}) {
  const {
    acquisition,
    appearance,
    canvas,
    changelog,
    encryptedPdf,
    intake,
    isMobile,
    mergePicker,
    openPlatformPath,
    pdfInsertionBusy,
    pendingPassword,
    rail,
    tabFlows,
    textSources,
    update,
  } = props;
  const { t } = useTranslation();
  const isPhone = useIsPhone();
  const opened = useEditorStore((s) => s.opened);
  const pageCount = useEditorStore((s) => s.model.pages.length);
  const readerMode = useEditorStore((s) => s.readerMode);
  const insertBlankPage = useEditorStore((s) => s.insertBlankPage);
  const setShowExport = useAppStore((s) => s.setShowExport);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const setShowShortcuts = useAppStore((s) => s.setShowShortcuts);
  const setShowFind = useAppStore((s) => s.setShowFind);
  const tabs = useWorkspace((state) => state.tabs);
  const activeTabId = useWorkspace((state) => state.activeTabId);
  const pendingRestore = useWorkspace((state) => state.session.pendingRestore);
  // The navigator needs a gutter to live in. Reader mode is deliberately
  // bare, and a fixed-width sidebar on a phone would eat the page — mobile
  // keeps the thumbnails drawer and the tab strip instead.
  const navigatorAvailable = !isMobile && !readerMode;

  const tabStrip = (
    <PdfExportAwareTabStrip
      tabs={tabStripItems(tabs, activeTabId)}
      activeTabId={activeTabId}
      onSelect={(id) => {
        void tabFlows.activate(id);
      }}
      onClose={(id) => {
        return tabFlows.close(id);
      }}
      onPreviewRequest={requestTabPreview}
      onReorder={tabFlows.reorder}
      onNew={() => {
        void acquisition.pick();
      }}
    />
  );

  const workspaceSwitcher = (
    <WorkspaceSwitcher
      items={switcherItems(tabs, activeTabId)}
      onCommit={(id) => {
        void tabFlows.activate(id);
      }}
    />
  );

  const chrome: WorkspaceChrome = {
    onHome: () => {
      void tabFlows.goHome();
    },
    onOpen: () => {
      void acquisition.pick();
    },
    onOpenSettings: () => setShowSettings(true),
    onOpenShortcuts: () => setShowShortcuts(true),
    navigatorOpen: rail.showNavigator,
    onToggleNavigator: navigatorAvailable ? rail.toggleThumbsForLayout : undefined,
    onToggleTerminal: CAPABILITIES.embeddedTerminal
      ? () => rail.openRailTabForLayout("terminal")
      : undefined,
    onToggleBrowser: CAPABILITIES.embeddedBrowserPanel
      ? () => rail.openRailTabForLayout("browser")
      : undefined,
    workspaceSwitcher,
    navigator: (
      <WorkspaceNavigator
        available={navigatorAvailable}
        isMobile={isMobile}
        tab={tab}
        tabFlows={tabFlows}
        acquisition={acquisition}
        mergePicker={mergePicker}
        openPlatformPath={openPlatformPath}
        pdfInsertionBusy={pdfInsertionBusy}
      />
    ),
    tabStrip,
    tabCount: tabs.length,
    showRail: rail.showRail,
    onCloseRail: rail.closeRail,
    webviewObscured: Boolean(
      changelog.showChangelog ||
        update.pendingUpdate ||
        pendingRestore ||
        pendingPassword,
    ),
    overlays,
  };
  const viewports: WorkspaceViewports = {
    docx: (shown) => (
      <DocxViewport
        tab={shown}
        fitToWidth={isMobile}
        onRetry={() => {
          void acquisition.reselectTab(shown.id);
        }}
      />
    ),
    text: (shown) => (
      <TextViewport
        tab={shown}
        effectiveTheme={appearance.effectiveTheme}
        prefsTheme={appearance.prefsTheme}
        textSources={textSources}
        onRetry={() => {
          void acquisition.reselectTab(shown.id);
        }}
      />
    ),
    pdfLoading: (shown) => (
      <DocumentLoadingState
        tab={shown}
        onRetry={() => {
          if (shown.unavailableDetail === "runtime-storage-admission-failed") {
            updateTab(shown.id, (current) => ({
              ...current,
              status: "suspended",
              unavailableDetail: undefined,
            }));
            void coldLoadTab(shown.id, intake);
            return;
          }
          void acquisition.reselectTab(shown.id);
        }}
      />
    ),
  };

  let openPdfView: OpenPdfView | null = null;
  if (opened && (!tab || tab.kind === "pdf")) {
    const meta = buildMeta(opened.fileSize, pageCount, t("meta.ppAbbr"));
    const emptyDoc = pageCount === 0;
    // Reader mode hides the top bar, but the window controls stay: the
    // macOS traffic lights and the Windows caption buttons float over the
    // page, so the page starts below them.
    const readerModeTrafficLightInsetTop = !readerMode
      ? 0
      : CAPABILITIES.customWindowCaption
        ? WINDOW_CAPTION_HEIGHT
        : CAPABILITIES.nativeWindowChrome && IS_MAC
          ? 34
          : 0;
    // The "+" that opens another document lives in the tab strip, and a phone
    // showing a single PDF no longer renders the strip. Every other branch
    // already hands the top bar its own opener; this one relied on the strip,
    // so give it the same button exactly when the strip is gone. Passing it
    // unconditionally would add a "+" to the desktop PDF bar, which has the
    // strip already.
    const pdfIdentityRow = documentIdentityRow({
      isPhone,
      tabCount: tabs.length,
      hasFileName: opened.fileName.length > 0,
    });

    openPdfView = {
      title: opened.fileName,
      meta,
      readerMode,
      navigatorOpen: isMobile ? rail.showThumbs : rail.showNavigator,
      onOpen:
        pdfIdentityRow === "tabStrip"
          ? undefined
          : () => {
              void acquisition.pick();
            },
      onOpenExport: () => setShowExport(true),
      onToggleNavigator: rail.toggleThumbsForLayout,
      onToggleOutline: rail.toggleOutlineForLayout,
      onFind: () => setShowFind(true),
      onPrint: CAPABILITIES.mobileShareExport
        ? undefined
        : () => void requestPrint(props.getActiveEditorStore()),
      contextualToolbar: <ContextualToolbar />,
      rowStyle: pdfDocumentRowStyle({
        readerMode,
        trafficLightInsetTop: readerModeTrafficLightInsetTop,
        safeTop: readerModeSafeTop,
      }),
      viewport: (
        <PdfViewport
          doc={opened.doc}
          fileName={opened.fileName}
          empty={emptyDoc}
          isMobile={isMobile}
          showThumbs={rail.showThumbs}
          showRail={rail.showRail}
          onDismissDrawers={() => {
            if (rail.showThumbs) rail.setShowThumbs(false);
            if (rail.showRail) rail.setShowRail(false);
          }}
          pdfInsertionBusy={pdfInsertionBusy}
          onInsertPdfPages={(afterPageId) => {
            void mergePicker.pick(afterPageId);
          }}
          onImport={() => {
            void acquisition.pick();
          }}
          onAddPage={() => insertBlankPage(null)}
        />
      ),
      railDoc: opened.doc,
      nativeWebviewObscured: Boolean(
        changelog.showChangelog ||
          update.pendingUpdate ||
          canvas.canvasWarning ||
          encryptedPdf.encryptedPdfWarningHash ||
          pendingRestore ||
          pendingPassword,
      ),
      afterRow: (
        <PdfOverlays
          isMobile={isMobile}
          changelog={props.changelog}
          update={props.update}
          canvas={props.canvas}
          encryptedPdf={props.encryptedPdf}
          acquisition={acquisition}
          intake={intake}
          mergePicker={props.mergePicker}
          getActiveEditorStore={props.getActiveEditorStore}
          openPlatformPath={props.openPlatformPath}
          fileInputRef={props.fileInputRef}
          insertPdfInputRef={props.insertPdfInputRef}
          pendingPassword={props.pendingPassword}
          setPendingPassword={props.setPendingPassword}
          storageFocusKey={props.storageFocusKey}
          setStorageFocusKey={props.setStorageFocusKey}
          tab={tab}
          doc={opened.doc}
          readerModeSafeTop={readerModeSafeTop}
        />
      ),
    };
  }

  return (
    <WorkspaceView
      tab={tab}
      chrome={chrome}
      openPdf={openPdfView}
      viewports={viewports}
    />
  );
}
