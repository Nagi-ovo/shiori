import { memo, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { PdfDocument } from "../../pdf/engine/types";
import { T } from "../../design/tokens";
import { TopBar } from "../../editor/components/TopBar";
import { documentIdentityRow } from "../../editor/components/documentIdentityRow";
import { useIsPhone } from "../../editor/hooks/useIsMobile";
import { RightRail } from "../../editor/components/RightRail";
import { recordTabPerfRender } from "../../perf/tabPerf";
import { usePdfExportStatus } from "./PdfExportStatusContext";
import type { DocumentKind } from "../../documents/types";

const DOCUMENT_ROW_KEY = "shioriDocumentRow";
// The skip link's target. One id, because only one document shell is mounted
// at a time (the inactive tabs' shells are not rendered).
export const MAIN_LANDMARK_ID = "shioriMain";

export type DocumentShellProps = Props;

type Props = {
  panelId?: string;
  documentKind: DocumentKind;
  title: string;
  meta: string;
  readerMode?: boolean;
  navigatorOpen: boolean;
  onHome: () => void;
  onOpen?: () => void;
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
  onOpenExport?: () => void;
  onToggleNavigator?: () => void;
  onToggleOutline?: () => void;
  onToggleTerminal?: () => void;
  onToggleBrowser?: () => void;
  onFind?: () => void;
  onPrint?: () => void;
  workspaceSwitcher: ReactNode;
  navigator: ReactNode;
  tabStrip: ReactNode;
  contextualToolbar?: ReactNode;
  viewport: ReactNode;
  railDoc: PdfDocument | null;
  showRail: boolean;
  onCloseRail: () => void;
  nativeWebviewObscured?: boolean;
  rowStyle?: CSSProperties;
  afterRow?: ReactNode;
  /**
   * Open workspace tabs. On a phone the strip and the top bar's filename
   * line are mutually exclusive — see documentIdentityRow. Required rather
   * than defaulted so a new document kind cannot quietly render neither.
   */
  tabCount: number;
};

// One persistent frame for every open document. PDF, Markdown, HTML, and a
// loading PDF replace only the viewport slot; the window toolbar, navigator
// column, tab strip, and live workspace rail keep the same React identity.
function DocumentShellComponent({
  panelId,
  documentKind,
  title,
  meta,
  readerMode = false,
  navigatorOpen,
  onHome,
  onOpen,
  onOpenSettings,
  onOpenShortcuts,
  onOpenExport,
  onToggleNavigator,
  onToggleOutline,
  onToggleTerminal,
  onToggleBrowser,
  onFind,
  onPrint,
  workspaceSwitcher,
  navigator,
  tabStrip,
  contextualToolbar,
  viewport,
  railDoc,
  showRail,
  onCloseRail,
  nativeWebviewObscured = false,
  rowStyle,
  afterRow,
  tabCount,
}: Props) {
  recordTabPerfRender("DocumentShell");
  const { t } = useTranslation();
  const exportStatus = usePdfExportStatus();
  const isPhone = useIsPhone();
  // Which row names the document. On a phone it is this or the top bar's
  // filename line, never both and never neither; anywhere else it is always
  // the strip, with the name inline in the bar as before.
  const identityRow = documentIdentityRow({
    isPhone,
    tabCount,
    hasFileName: title.length > 0,
  });
  return (
    <div
      id={panelId}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: T.paper,
        fontFamily: T.sans,
        color: T.ink,
        overflow: "hidden",
      }}
    >
      {/* First focusable thing on the page, visible only while focused. */}
      <a className="shioriSkipLink" href={`#${MAIN_LANDMARK_ID}`}>
        {t("nav.skipToContent")}
      </a>
      {readerMode ? null : (
        <TopBar
          documentKind={documentKind}
          fileName={title}
          meta={meta}
          onOpen={onOpen}
          onOpenExport={onOpenExport}
          onOpenSettings={onOpenSettings}
          onOpenShortcuts={onOpenShortcuts}
          onToggleThumbs={onToggleNavigator}
          navigatorOpen={navigatorOpen}
          onToggleOutline={onToggleOutline}
          onToggleTerminal={onToggleTerminal}
          onToggleBrowser={onToggleBrowser}
          onGoHome={onHome}
          onFind={onFind}
          onPrint={onPrint}
          exportNeedsAttention={exportStatus.kind === "needsExport"}
          exportStatusLabel={`${t("nav.exportPdf")} · ${t(
            `exportStatus.${exportStatus.kind}`,
          )}`}
          tabCount={tabCount}
        />
      )}
      {workspaceSwitcher}
      <div
        key={DOCUMENT_ROW_KEY}
        data-shiori-document-row
        style={{
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          display: "flex",
          position: "relative",
          boxSizing: "border-box",
          ...rowStyle,
        }}
      >
        {navigator}
        <div
          data-shiori-document-column
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {readerMode || identityRow !== "tabStrip" ? null : tabStrip}
          {readerMode ? null : contextualToolbar}
          {/* The document itself is the page's one primary landmark. The app
              was an untagged div tree, so a screen-reader user had no way to
              jump to the content and had to tab through the whole chrome —
              top bar, navigator, tab strip, toolbar — on every visit.
              tabIndex -1 so the skip link above can move focus here. */}
          <main
            id={MAIN_LANDMARK_ID}
            tabIndex={-1}
            aria-label={t("nav.mainLandmark")}
            data-shiori-document-viewport
            style={{
              flex: 1,
              minHeight: 0,
              minWidth: 0,
              display: "flex",
              position: "relative",
            }}
          >
            {viewport}
          </main>
        </div>
        {showRail ? (
          <RightRail
            doc={railDoc}
            onClose={onCloseRail}
            nativeWebviewObscured={nativeWebviewObscured}
          />
        ) : null}
      </div>
      {afterRow}
    </div>
  );
}

export const DocumentShell = memo(DocumentShellComponent);
