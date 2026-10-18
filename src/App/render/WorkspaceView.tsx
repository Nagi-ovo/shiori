import type { ReactNode } from "react";
import {
  documentKindShortLabel,
  isTextDocumentKind,
} from "../../documents/types";
import { SAFE_BOTTOM_ROW_STYLE } from "../../editor/components/documentRowLayout";
import { formatBytes } from "../../shared/format";
import type { WorkspaceRuntimeTab } from "../../workspace/types";
import { DocumentShell, type DocumentShellProps } from "./DocumentShell";

/** The shell every open document shares: window chrome, navigator, rail. */
export type WorkspaceChrome = Pick<
  DocumentShellProps,
  | "onHome"
  | "onOpenSettings"
  | "onOpenShortcuts"
  | "onToggleTerminal"
  | "onToggleBrowser"
  | "workspaceSwitcher"
  | "navigator"
  | "tabStrip"
  | "tabCount"
  | "showRail"
  | "onCloseRail"
> & {
  onOpen: () => void;
  navigatorOpen: boolean;
  /** Opens or closes the navigator; undefined where it cannot show. */
  onToggleNavigator: (() => void) | undefined;
  /** A modal covers the window, so the rail's native webview must hide. */
  webviewObscured: boolean;
  /** The window's dialogs, toasts and pickers, below the document row. */
  overlays: ReactNode;
};

type OpenPdfKeys =
  | "title"
  | "meta"
  | "viewport"
  | "afterRow"
  | "readerMode"
  | "navigatorOpen"
  | "onOpen"
  | "onOpenExport"
  | "onToggleNavigator"
  | "onToggleOutline"
  | "onFind"
  | "onPrint"
  | "contextualToolbar"
  | "rowStyle"
  | "railDoc"
  | "nativeWebviewObscured";

/**
 * What an open PDF changes in the shell: its own chrome and dialogs. Every
 * key is required, even where its value may be undefined, so a key left out
 * cannot let the shared chrome's value through.
 */
export type OpenPdfView = { [K in OpenPdfKeys]: DocumentShellProps[K] };

export type WorkspaceViewports = {
  docx: (tab: WorkspaceRuntimeTab) => ReactNode;
  text: (tab: WorkspaceRuntimeTab) => ReactNode;
  /** A PDF tab whose document is not open yet (or could not be restored). */
  pdfLoading: (tab: WorkspaceRuntimeTab) => ReactNode;
};

/**
 * The document on screen, in the one shell every kind shares. Only the
 * viewport and the PDF's own chrome change with the document; the top bar,
 * navigator, tab strip and right rail are one mount, so switching between a
 * PDF, a Markdown file and a Word document never remounts the rail's
 * terminal or browser (POSTMORTEMS 2026-07-30).
 */
export function WorkspaceView({
  tab,
  chrome,
  openPdf,
  viewports,
}: {
  tab: WorkspaceRuntimeTab | null | undefined;
  chrome: WorkspaceChrome;
  /** The open PDF, when the screen shows one. */
  openPdf: OpenPdfView | null;
  viewports: WorkspaceViewports;
}) {
  const { overlays, webviewObscured, ...shared } = chrome;
  const panelId = tab ? `shiori-document-panel-${tab.id}` : undefined;
  if (openPdf && (!tab || tab.kind === "pdf")) {
    return (
      <DocumentShell
        {...shared}
        panelId={panelId}
        documentKind="pdf"
        {...openPdf}
      />
    );
  }
  // With neither a tab nor an open PDF, App shows home instead.
  if (!tab) return null;
  const textKind = isTextDocumentKind(tab.kind)
    ? tab.kind === "html"
      ? "html"
      : "markdown"
    : null;
  return (
    <DocumentShell
      {...shared}
      panelId={panelId}
      rowStyle={SAFE_BOTTOM_ROW_STYLE}
      documentKind={textKind ?? tab.kind}
      title={tab.title}
      meta={`${
        textKind === "markdown" ? "Markdown" : documentKindShortLabel(tab.kind)
      } · ${formatBytes(tab.size)}`}
      railDoc={null}
      nativeWebviewObscured={webviewObscured}
      viewport={
        tab.kind === "docx"
          ? viewports.docx(tab)
          : textKind
            ? viewports.text(tab)
            : viewports.pdfLoading(tab)
      }
      afterRow={overlays}
    />
  );
}
