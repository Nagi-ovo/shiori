import {
  assertDocumentWithinFileLimit,
  DocumentOpenPolicyError,
} from "../../documents/openPolicy";
import {
  detectDocumentKind,
  type DocumentKind,
  type LoadedDocumentPayload,
} from "../../documents/types";
import { recentMatchesFile, type RecentEntry } from "../../editor/recentDocs";
import { isPlatformPdfOpenError } from "../../platform";
import {
  isWebFileHandleOpenError,
  type WebFileHandleDocumentPayload,
  type WebFileHandleOpenErrorCode,
} from "../../storage/recentFileHandles";
import type { WorkspaceSourceBlob } from "../../storage/workspace";
import type { TabSourceRead } from "../intake/readTabSource";
import type {
  DocumentOpenOptions,
  PdfOpenInput,
  PdfOpenOptions,
} from "../intake/types";
import type { WorkspaceRuntimeTab } from "../types";
import type { WorkspaceStore } from "../workspaceStore";

/** What the reader is told; App turns these into translated toasts. */
export type AcquireNotice =
  | { kind: "unsupported"; name: string | undefined }
  /** A size or package policy refused a non-PDF document before reading it. */
  | {
      kind: "policyRefused";
      error: DocumentOpenPolicyError;
      name: string;
      documentKind: Exclude<DocumentKind, "pdf">;
    }
  | { kind: "openFailed"; error: unknown; name?: string; detail?: string }
  /** A recent row whose file is gone; the row has been removed. */
  | { kind: "recentMissing"; detail: string }
  /** A recent text document whose working copy is gone; the row is removed. */
  | { kind: "workingCopyMissing"; name: string }
  /** The browser no longer lets us read a recent file; the row stays. */
  | {
      kind: "webAccessLost";
      name: string;
      code?: WebFileHandleOpenErrorCode;
      reauthorize: () => void;
    }
  | { kind: "webAccessGone"; name: string }
  | { kind: "webUnsupported"; name: string }
  /** A restore-failed tab could not reread its file. */
  | { kind: "restoreFailed"; title: string; detail: string; pickAgain: () => void };

type PickedFile = WebFileHandleDocumentPayload;

export type AcquirePorts = {
  store: WorkspaceStore;
  platform: {
    /** Desktop: the native dialog, file paths and file associations. */
    nativePaths: boolean;
    mobileDocumentPicker: boolean;
    isTauri: boolean;
    isMac: boolean;
    kindEnabled: (kind: DocumentKind) => boolean;
    /** The native (desktop or mobile) multi-select document picker. */
    pickDocuments: (
      onFailure: (error: Error, name?: string) => void,
    ) => Promise<LoadedDocumentPayload[]>;
    /** macOS: one panel that returns files and folders. */
    pickPaths: () => Promise<string[]>;
    /** Classifies and opens a path the way drag-drop does. */
    openPath: (path: string) => Promise<void>;
    readPdfAtPath: (
      path: string,
    ) => Promise<{ name: string; size: number; bytes: Uint8Array; path?: string } | null>;
    readDocumentAtPath: (path: string) => Promise<LoadedDocumentPayload | null>;
  };
  webHandles: {
    canUse: () => boolean;
    pickDocument: () => Promise<PickedFile | null>;
    /** The Open picker: a multi-select, each unreadable file reported. */
    pickDocuments: (
      onError: (error: unknown, name?: string) => void,
    ) => Promise<PickedFile[]>;
    pickPdf: () => Promise<PickedFile | null>;
    readDocument: (id: string) => Promise<PickedFile>;
    readPdf: (id: string) => Promise<PickedFile>;
    forget: (id: string | undefined) => void;
  };
  /** The hidden `<input type=file>`, the last-resort picker. */
  clickFileInput: () => void;
  readTabSource: (tab: WorkspaceRuntimeTab) => Promise<TabSourceRead>;
  getCachedSource: (cacheId: string) => Promise<WorkspaceSourceBlob | undefined>;
  hash: (bytes: Uint8Array) => Promise<string>;
  forgetRecent: (entry: RecentEntry) => void;
  open: {
    document: (payload: LoadedDocumentPayload, options?: DocumentOpenOptions) => Promise<unknown>;
    pdf: (input: PdfOpenInput, options?: PdfOpenOptions) => Promise<unknown>;
  };
  coldLoad: (tabId: string) => Promise<void>;
  /** Clears the marker a superseded restore of this tab left behind. */
  settleSupersededLoad: (tabId: string) => void;
  notify: (notice: AcquireNotice) => void;
};

/**
 * Where documents come from before intake opens them: the file picker on
 * each platform, dropped files, recents, and a restore-failed tab picking
 * its file again. Every route ends in `open.document` or `open.pdf`.
 *
 * Several files are opened one after another, in the order they were
 * picked: in parallel every open would race, and the open generation keeps
 * only the last.
 */
export function createDocumentAcquisition(ports: AcquirePorts) {
  const { platform, webHandles } = ports;
  const webHandlesUsable = () => !platform.isTauri && webHandles.canUse();
  const nativePicker = () => platform.nativePaths || platform.mobileDocumentPicker;

  const acceptedKind = (name: string): DocumentKind | null => {
    const kind = detectDocumentKind(name);
    if (kind && platform.kindEnabled(kind)) return kind;
    ports.notify({ kind: "unsupported", name });
    return null;
  };

  const forgetMissing = (entry: RecentEntry, detail: string) => {
    ports.forgetRecent(entry);
    webHandles.forget(entry.webFileHandleId);
    ports.notify({ kind: "recentMissing", detail });
  };

  async function openFile(file: File): Promise<void> {
    const kind = acceptedKind(file.name);
    if (!kind) return;
    if (kind !== "pdf") {
      try {
        // File.size is known before arrayBuffer(), so a large document is
        // refused without first allocating all its bytes.
        assertDocumentWithinFileLimit(kind, file.size);
      } catch (error) {
        if (error instanceof DocumentOpenPolicyError) {
          ports.notify({ kind: "policyRefused", error, name: file.name, documentKind: kind });
          return;
        }
        throw error;
      }
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    await ports.open.document({ kind, name: file.name, size: file.size, bytes });
  }

  async function openFiles(files: File[]): Promise<void> {
    for (const file of files) {
      try {
        await openFile(file);
      } catch (error) {
        ports.notify({ kind: "openFailed", error, name: file.name, detail: file.name });
      }
    }
  }

  const pickedPayload = (picked: PickedFile, kind: DocumentKind): LoadedDocumentPayload => ({
    kind,
    name: picked.name,
    size: picked.size,
    bytes: picked.bytes,
    webFileHandleId: picked.webFileHandleId,
  });

  /**
   * Opens the platform's picker: the native dialog on desktop (absolute
   * paths) and mobile, the File System Access picker on Chromium (a handle
   * that survives reload), the plain file input elsewhere.
   */
  async function pick(file?: File): Promise<void> {
    if (file) {
      await openFile(file);
      return;
    }
    if (nativePicker()) {
      try {
        const picked = await platform.pickDocuments((error, name) =>
          ports.notify({ kind: "openFailed", error, name }),
        );
        // A claimed intent backgrounds every slower open still in flight, so
        // a pick that opens nothing (a cancel) must not claim one.
        if (picked.length === 0) return;
        const foregroundIntent = ports.store.getState().claimForegroundIntent();
        for (const payload of picked) {
          await ports.open.document(payload, { foregroundIntent });
        }
      } catch (error) {
        ports.notify({ kind: "openFailed", error });
      }
      return;
    }
    if (webHandlesUsable()) {
      try {
        const picked = await webHandles.pickDocuments((error, name) =>
          ports.notify({ kind: "openFailed", error, name }),
        );
        const accepted = picked.flatMap((file) => {
          const kind = acceptedKind(file.name);
          return kind ? [pickedPayload(file, kind)] : [];
        });
        if (accepted.length === 0) return;
        const foregroundIntent = ports.store.getState().claimForegroundIntent();
        for (const loaded of accepted) {
          await ports.open.document(loaded, { foregroundIntent });
        }
      } catch (error) {
        ports.notify({ kind: "openFailed", error });
      }
      return;
    }
    ports.clickFileInput();
  }

  /**
   * The navigator's Add control. macOS returns files and folders from one
   * panel, each classified like a drop; Windows and Linux dialogs cannot mix
   * the two, so there it is the document picker.
   */
  async function pickWorkspaceTarget(): Promise<void> {
    if (!platform.isMac || !platform.nativePaths) {
      await pick();
      return;
    }
    try {
      for (const path of await platform.pickPaths()) {
        await platform.openPath(path);
      }
    } catch (error) {
      ports.notify({ kind: "openFailed", error });
    }
  }

  /** A restore-failed tab reads its file again, into the same tab. */
  async function reselectTab(tabId: string): Promise<void> {
    const tab = ports.store.getState().tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    if (tab.unavailableDetail === "pdf-password-required") {
      ports.store.getState().updateTab(tabId, (current) => ({
        ...current,
        status: "unloaded",
        unavailableDetail: undefined,
      }));
      await ports.coldLoad(tabId);
      return;
    }
    const intoTab = {
      tabId,
      pdfView: tab.pdfView,
      textView: tab.textView,
      skipDuplicateCheck: true,
    };
    if (tab.source.type === "webFileHandle" && !platform.isTauri) {
      try {
        const loaded = await ports.readTabSource(tab);
        await ports.open.document(loaded.payload, {
          ...intoTab,
          workingCopyCacheId: loaded.workingCopyCacheId,
        });
        ports.settleSupersededLoad(tabId);
      } catch (error) {
        ports.notify({
          kind: "restoreFailed",
          title: tab.title,
          detail: error instanceof Error ? error.message : String(error),
          pickAgain: () => {
            void pick();
          },
        });
      }
      return;
    }
    if (webHandlesUsable()) {
      try {
        const picked = await webHandles.pickDocument();
        if (!picked) return;
        const kind = acceptedKind(picked.name);
        if (!kind) return;
        await ports.open.document(pickedPayload(picked, kind), intoTab);
        ports.settleSupersededLoad(tabId);
      } catch (error) {
        ports.notify({ kind: "openFailed", error, name: tab.title });
      }
      return;
    }
    // Desktop and mobile once had no tab-targeted reselect: the generic
    // picker's result matched this very tab as a duplicate, so choosing the
    // same file again did nothing and the restore-failed screen stayed up.
    if (nativePicker()) {
      try {
        const [first, ...rest] = await platform.pickDocuments((error, name) =>
          ports.notify({ kind: "openFailed", error, name: name ?? tab.title }),
        );
        if (!first) return;
        const foregroundIntent = ports.store.getState().claimForegroundIntent();
        await ports.open.document(first, {
          ...intoTab,
          foregroundIntent,
          shouldActivate: () =>
            ports.store.getState().activeTabId === tabId &&
            ports.store.getState().tabs.some((candidate) => candidate.id === tabId),
        });
        ports.settleSupersededLoad(tabId);
        // Multi-select still honours the extra picks, as new tabs.
        for (const payload of rest) {
          await ports.open.document(payload, { foregroundIntent });
        }
      } catch (error) {
        ports.notify({ kind: "openFailed", error, name: tab.title });
      }
      return;
    }
    await pick();
  }

  /** Picks a recent PDF again after the browser dropped its handle. */
  async function reauthorizeRecent(entry: RecentEntry): Promise<void> {
    if (!webHandles.canUse()) {
      ports.notify({ kind: "webAccessGone", name: entry.name });
      return;
    }
    try {
      const picked = await webHandles.pickPdf();
      if (!picked) return;
      const hash = await ports.hash(picked.bytes);
      await ports.open.pdf({
        name: picked.name,
        size: picked.size,
        bytes: picked.bytes,
        hash,
        webFileHandleId: picked.webFileHandleId,
        replaceRecentEntry: recentMatchesFile(entry, {
          name: picked.name,
          size: picked.size,
          hash,
        })
          ? entry
          : undefined,
      });
    } catch (error) {
      ports.notify({ kind: "openFailed", error, name: entry.name });
    }
  }

  /**
   * A web handle the browser revoked or forgot. Unlike a missing desktop
   * path the row stays: the reader can grant access again or forget it.
   */
  const webAccessLost = (entry: RecentEntry, error?: unknown) => {
    if (!webHandles.canUse()) {
      ports.notify({ kind: "webUnsupported", name: entry.name });
      return;
    }
    ports.notify({
      kind: "webAccessLost",
      name: entry.name,
      code: isWebFileHandleOpenError(error) ? error.code : undefined,
      reauthorize: () => {
        void reauthorizeRecent(entry);
      },
    });
  };

  async function reopenTextRecent(entry: RecentEntry): Promise<boolean> {
    const originPath = entry.path && platform.nativePaths ? entry.path : undefined;
    const originHandle =
      entry.webFileHandleId && !platform.isTauri ? entry.webFileHandleId : undefined;
    try {
      // A text working copy is newer than its origin. Open it, carrying the
      // origin forward so relative images and document identity still work.
      if (entry.cacheId) {
        const source = await ports.getCachedSource(entry.cacheId);
        if (source && source.kind === entry.kind && source.kind !== "pdf") {
          await ports.open.document({
            kind: source.kind,
            name: source.name,
            size: source.size,
            bytes: source.bytes,
            path: originPath,
            webFileHandleId: originHandle,
            cacheId: source.id,
          });
          return true;
        }
        ports.forgetRecent(entry);
        ports.notify(
          originPath || originHandle
            ? { kind: "workingCopyMissing", name: entry.name }
            : { kind: "recentMissing", detail: entry.name },
        );
        return false;
      }
      if (originPath) {
        const payload = await platform.readDocumentAtPath(originPath);
        if (!payload) throw new Error("recent-missing");
        await ports.open.document(payload);
        return true;
      }
      if (originHandle) {
        const picked = await webHandles.readDocument(originHandle);
        const kind = detectDocumentKind(picked.name);
        if (!kind) throw new Error("unsupported-document");
        await ports.open.document({ ...picked, kind, webFileHandleId: originHandle });
        return true;
      }
    } catch (error) {
      if (isPlatformPdfOpenError(error) && error.code === "unavailable") {
        forgetMissing(entry, entry.path ?? entry.name);
        return false;
      }
      if (isWebFileHandleOpenError(error)) {
        webAccessLost(entry, error);
        return false;
      }
      ports.notify({
        kind: "openFailed",
        error,
        name: entry.name,
        detail: entry.path ?? entry.name,
      });
      return false;
    }
    forgetMissing(entry, entry.path ?? entry.name);
    return false;
  }

  /**
   * Opens a recent document. Desktop paths are hard pointers, so a missing
   * file drops its row; web handles are softer and keep theirs for a retry.
   * True when the document opened.
   */
  async function reopenRecent(entry: RecentEntry): Promise<boolean> {
    if (entry.kind && entry.kind !== "pdf") return reopenTextRecent(entry);
    if (entry.path && platform.nativePaths) {
      try {
        const payload = await platform.readPdfAtPath(entry.path);
        if (payload) {
          await ports.open.pdf({
            name: payload.name,
            size: payload.size,
            bytes: payload.bytes,
            path: payload.path,
          });
          return true;
        }
      } catch (error) {
        ports.forgetRecent(entry);
        webHandles.forget(entry.webFileHandleId);
        if (isPlatformPdfOpenError(error) && error.code === "unavailable") {
          ports.notify({ kind: "recentMissing", detail: entry.path });
        } else {
          ports.notify({ kind: "openFailed", error, name: entry.name, detail: entry.path });
        }
        return false;
      }
      forgetMissing(entry, entry.path);
      return false;
    }
    if (entry.webFileHandleId && !platform.isTauri) {
      try {
        const payload = await webHandles.readPdf(entry.webFileHandleId);
        await ports.open.pdf({
          name: payload.name,
          size: payload.size,
          bytes: payload.bytes,
          webFileHandleId: entry.webFileHandleId,
        });
        return true;
      } catch (error) {
        webAccessLost(entry, error);
        return false;
      }
    }
    if (entry.cacheId) {
      try {
        const source = await ports.getCachedSource(entry.cacheId);
        if (!source || source.kind !== "pdf") throw new Error("recent-cache-missing");
        await ports.open.pdf({
          name: source.name,
          size: source.size,
          bytes: source.bytes,
          cacheId: source.id,
          replaceRecentEntry: entry,
        });
        return true;
      } catch {
        forgetMissing(entry, entry.name);
        return false;
      }
    }
    forgetMissing(entry, entry.path ?? entry.name);
    return false;
  }

  return { openFile, openFiles, pick, pickWorkspaceTarget, reselectTab, reopenRecent };
}

export type DocumentAcquisition = ReturnType<typeof createDocumentAcquisition>;
