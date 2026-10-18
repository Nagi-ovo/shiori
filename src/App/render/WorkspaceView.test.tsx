import "../../test/setupDom";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import i18n from "../../i18n";
import type { PdfDocument } from "../../pdf/engine/types";
import type { WorkspaceRuntimeTab } from "../../workspace/types";
import { createWorkspaceStore, type WorkspaceStore } from "../../workspace/workspaceStore";
import {
  WorkspaceView,
  type OpenPdfView,
  type WorkspaceChrome,
  type WorkspaceViewports,
} from "./WorkspaceView";

const tabs = [
  { id: "paper", kind: "pdf", title: "paper.pdf", size: 1, status: "unloaded" },
  { id: "notes", kind: "markdown", title: "notes.md", size: 1, status: "loaded" },
  { id: "brief", kind: "docx", title: "brief.docx", size: 1, status: "loaded" },
] as WorkspaceRuntimeTab[];

const chrome: WorkspaceChrome = {
  onHome: () => {},
  onOpen: () => {},
  onOpenSettings: () => {},
  onOpenShortcuts: () => {},
  navigatorOpen: false,
  onToggleNavigator: undefined,
  workspaceSwitcher: null,
  navigator: null,
  tabStrip: null,
  tabCount: tabs.length,
  showRail: true,
  onCloseRail: () => {},
  webviewObscured: false,
  overlays: null,
};

const viewports: WorkspaceViewports = {
  docx: (tab) => <div data-viewport="docx">{tab.title}</div>,
  text: (tab) => <div data-viewport="text">{tab.title}</div>,
  pdfLoading: (tab) => <div data-viewport="pdf-loading">{tab.title}</div>,
};

const openPaper: OpenPdfView = {
  title: "paper.pdf",
  meta: "1 pp · 1 KB",
  viewport: <div data-viewport="pdf">pages</div>,
  afterRow: null,
  readerMode: false,
  navigatorOpen: false,
  onOpen: undefined,
  onOpenExport: () => {},
  onToggleNavigator: () => {},
  onToggleOutline: () => {},
  onFind: () => {},
  onPrint: undefined,
  contextualToolbar: null,
  rowStyle: undefined,
  railDoc: null as PdfDocument | null,
  nativeWebviewObscured: false,
};

/** App's shape: the active tab comes from the workspace store. */
function Screen({ store, openPdf }: { store: WorkspaceStore; openPdf: () => OpenPdfView | null }) {
  const tab = store((state) => state.tabs.find((entry) => entry.id === state.activeTabId));
  return (
    <WorkspaceView
      tab={tab}
      chrome={chrome}
      openPdf={tab?.kind === "pdf" ? openPdf() : null}
      viewports={viewports}
    />
  );
}

describe("WorkspaceView", () => {
  const desktopMatchMedia = window.matchMedia;

  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
    window.matchMedia = desktopMatchMedia;
  });

  // The rail hosts the embedded terminal (its pty dies with the component)
  // and the native browser webview (a remount reads as a blink). It was
  // remounted by switching document kinds four times before; see
  // POSTMORTEMS 2026-07-30.
  test("switching between document kinds keeps the same rail", () => {
    // A phone layout: on desktop web the rail has nothing to show (its
    // terminal and browser are desktop-app only) and does not render.
    window.matchMedia = ((query: string) => ({
      ...desktopMatchMedia(query),
      matches: query.includes("max-width"),
    })) as typeof window.matchMedia;
    const store = createWorkspaceStore({ tabs, activeTabId: "paper", folderPaths: [] });
    let pdfOpen = false;
    const view = render(<Screen store={store} openPdf={() => (pdfOpen ? openPaper : null)} />);
    const rail = () => view.container.querySelector("[data-shiori-document-row] > aside");
    const viewport = () => view.container.querySelector("[data-viewport]")?.getAttribute("data-viewport");
    const first = rail();
    expect(first).toBeTruthy();
    expect(viewport()).toBe("pdf-loading");

    const seen: (string | null | undefined)[] = [];
    for (const [tabId, open] of [
      ["notes", false],
      ["brief", false],
      ["paper", true],
      ["notes", true],
    ] as const) {
      pdfOpen = open;
      act(() => store.setState({ activeTabId: tabId }));
      seen.push(viewport());
      expect(Object.is(rail(), first)).toBe(true);
    }
    expect(seen).toEqual(["text", "docx", "pdf", "text"]);
  });
});
