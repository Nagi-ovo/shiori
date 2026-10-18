import type { DocumentKind } from "../documents/types";
import { forgetRecent } from "../editor/recentDocs";
import {
  CAPABILITIES,
  IS_MAC,
  IS_TAURI,
  openDocumentsFromPlatform,
  readDocumentBytesFromPlatformPath,
  readPdfAtPath,
} from "../platform";
import { pickFolderFromPlatform } from "../platform/folderMount";
import { sha256Hex } from "../storage/hash";
import {
  canUseWebFileHandles,
  forgetWebFileHandle,
  openDocumentWithWebFileHandlePicker,
  openPdfWithWebFileHandlePicker,
  readDocumentFromWebFileHandle,
  readPdfFromWebFileHandle,
} from "../storage/recentFileHandles";
import { getWorkspaceSource } from "../storage/workspace";
import {
  createDocumentAcquisition,
  type AcquireNotice,
} from "../workspace/acquire/acquire";
import { coldLoadTab, settleSupersededLoad, type ColdLoadPorts } from "../workspace/intake/coldLoad";
import { openDocument } from "../workspace/intake/openDocument";
import { openPdf } from "../workspace/intake/openPdf";
import { readTabSource } from "../workspace/intake/readTabSource";
import { workspaceStore } from "../workspace/appWorkspace";

/** What App owns that changes over time: set by `connect`, read per route. */
type Live = {
  intake: ColdLoadPorts | null;
  clickFileInput: () => void;
  openPath: (path: string) => Promise<void>;
  notify: (notice: AcquireNotice) => void;
};

/**
 * Document acquisition on the real platform. It is created once; App hands it
 * the latest intake ports, picker input and notice handler through `connect`
 * from effects, so a route reads them when it runs rather than capturing
 * them at creation.
 */
export function createAppAcquisition() {
  const live: Live = {
    intake: null,
    clickFileInput: () => {},
    openPath: async () => {},
    notify: () => {},
  };
  const intake = () => {
    if (!live.intake) throw new Error("intake-not-ready");
    return live.intake;
  };
  const acquisition = createDocumentAcquisition({
    store: workspaceStore(),
    platform: {
      nativePaths: CAPABILITIES.nativePaths,
      mobileDocumentPicker: CAPABILITIES.mobileDocumentPicker,
      isTauri: IS_TAURI,
      isMac: IS_MAC,
      kindEnabled: (kind: DocumentKind) => kind === "pdf" || CAPABILITIES.textDocuments,
      pickDocuments: openDocumentsFromPlatform,
      pickPaths: pickFolderFromPlatform,
      openPath: (path) => live.openPath(path),
      readPdfAtPath,
      readDocumentAtPath: readDocumentBytesFromPlatformPath,
    },
    webHandles: {
      canUse: canUseWebFileHandles,
      pickDocument: () => openDocumentWithWebFileHandlePicker(),
      pickPdf: () => openPdfWithWebFileHandlePicker(),
      readDocument: readDocumentFromWebFileHandle,
      readPdf: readPdfFromWebFileHandle,
      forget: (id) => void forgetWebFileHandle(id),
    },
    clickFileInput: () => live.clickFileInput(),
    readTabSource,
    getCachedSource: getWorkspaceSource,
    hash: sha256Hex,
    forgetRecent,
    open: {
      document: (payload, options) => openDocument(payload, options ?? {}, intake()),
      pdf: (input, options) => openPdf(input, options ?? {}, intake()),
    },
    coldLoad: (tabId) => coldLoadTab(tabId, intake()),
    settleSupersededLoad: (tabId) => settleSupersededLoad(tabId, intake()),
    notify: (notice) => live.notify(notice),
  });
  return {
    ...acquisition,
    connect(next: Partial<Live>): void {
      Object.assign(live, next);
    },
  };
}

export type AppAcquisition = ReturnType<typeof createAppAcquisition>;
