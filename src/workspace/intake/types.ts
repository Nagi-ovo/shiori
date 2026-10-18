import type { ErrorInfo, PdfEditorStoreApi } from "../../editor/store/store";
import type { RecentEntry } from "../../editor/recentDocs";
import type {
  DocumentKind,
  LoadedDocumentPayload,
} from "../../documents/types";
import type { PdfEngine } from "../../pdf/engine/types";
import type { Draft } from "../../storage/drafts";
import type { OperationLogEntry } from "../../storage/operationLog";
import type { SuspendedPdfSnapshot } from "../../storage/runtimeSessions";
import type {
  WorkspacePdfViewState,
  WorkspaceTextViewState,
} from "../../storage/workspace";
import type { WorkspaceRuntimeTab } from "../types";
import type { WorkspaceStore } from "../workspaceStore";

export type PdfOpenInput = {
  file?: File;
  name: string;
  size: number;
  bytes: Uint8Array;
  hash?: string;
  path?: string;
  webFileHandleId?: string;
  cacheId?: string;
  password?: string;
  replaceRecentEntry?: RecentEntry;
};

export type PdfOpenOptions = {
  /** Restores into this existing tab instead of opening a new one. */
  tabId?: string;
  pdfView?: WorkspacePdfViewState;
  runtimeSnapshot?: SuspendedPdfSnapshot;
  password?: string;
  skipDuplicateCheck?: boolean;
  /** An extra condition for taking the screen, e.g. "my tab is still active". */
  shouldActivate?: () => boolean;
  /** Joins a multi-select batch (workspaceStore claimForegroundIntent). */
  foregroundIntent?: number;
};

export type TextOpenOptions = {
  tabId?: string;
  textView?: WorkspaceTextViewState;
  workingCopyCacheId?: string;
  skipDuplicateCheck?: boolean;
  shouldActivate?: () => boolean;
  foregroundIntent?: number;
};

export type DocumentOpenOptions = Omit<PdfOpenOptions, "password"> &
  TextOpenOptions & { pdfPassword?: string };

export type NonPdfPayload = LoadedDocumentPayload & {
  kind: Exclude<DocumentKind, "pdf">;
};

/** An open waiting on the password dialog; retried with the full frame. */
export type PendingPassword = {
  input: PdfOpenInput;
  options: PdfOpenOptions;
  wrongPassword?: boolean;
};

/**
 * Everything the open pipeline touches outside the workspace store. App wires
 * the real ones; tests pass fakes.
 */
export type IntakePorts = {
  store: WorkspaceStore;
  engine: PdfEngine;
  /** PDF opens and cold resumes share resident slots: run them one at a time. */
  enqueuePdfOpen: <T>(job: () => Promise<T>) => Promise<T>;
  settings: () => {
    compactLayout: boolean;
    animateOverlays: boolean;
  };

  /** Saves the document on screen before another replaces it; false = stay. */
  persistActive: () => Promise<boolean>;
  activateLoadedTab: (tabId: string) => Promise<void>;
  /** A restore that lost its claim; the cold loader reads this back. */
  markSuperseded: (tabId: string) => void;

  sources: {
    /** Gives a sourceless payload a workspace cache row. */
    ensure: (payload: LoadedDocumentPayload) => Promise<LoadedDocumentPayload>;
    get: (cacheId: string) => Promise<
      | {
          id: string;
          kind: DocumentKind;
          name: string;
          size: number;
          bytes: Uint8Array;
        }
      | undefined
    >;
    removeIfUnreferenced: (cacheId: string) => void;
  };

  drafts: {
    get: (hash: string) => Promise<Draft | undefined>;
    getLiveOperationReceipts: (hash: string) => Promise<string[]>;
    mergeLiveOperationReceipts: (
      hash: string,
      ids: string[],
    ) => Promise<unknown>;
    readOperationLog: (hash: string) => OperationLogEntry | null;
  };

  editors: {
    get: (tabId: string) => PdfEditorStoreApi | undefined;
    ensure: (tabId: string) => PdfEditorStoreApi;
    remove: (tabId: string) => void;
    touch: (tabId: string) => void;
    show: (store: PdfEditorStoreApi) => void;
    /** Shows the empty PDF store (no PDF on screen). */
    detach: () => void;
    /** Whether any PDF is on screen right now. */
    hasOpenDocument: () => boolean;
    /** Makes room for one more resident PDF; false has been reported. */
    reserveResidentSlot: (tabId: string) => Promise<boolean>;
  };

  runtime: {
    removeSession: (tabId: string) => Promise<void>;
    rememberCredential: (tabId: string, password: string | undefined) => void;
  };

  recents: {
    list: () => RecentEntry[];
    canReopen: (entry: Omit<RecentEntry, "savedAt">) => boolean;
    record: (entry: Omit<RecentEntry, "savedAt">) => void;
    replace: (
      previous: RecentEntry,
      entry: Omit<RecentEntry, "savedAt">,
    ) => void;
    forget: (entry: RecentEntry) => void;
    forgetWebFileHandle: (id: string) => void;
    attachThumb: (key: string, thumb: string) => void;
    /** See CloseTabPorts.recordTextRecent; the result is ignored on open. */
    recordText: (tab: WorkspaceRuntimeTab) => boolean;
    lastPage: (key: string) => number | undefined;
  };

  ui: {
    setError: (error: ErrorInfo | null) => void;
    requestPassword: (pending: PendingPassword) => void;
    warnAboutCanvas: () => void;
    /** Builds the reader-facing description of a failed PDF open. */
    describeOpenError: (name: string, size: number, error: unknown) => ErrorInfo;
    toastError: (title: string, detail?: string) => void;
    /** Toasts a Word/Markdown size or package rejection; false if not one. */
    reportDocumentPolicyError: (
      error: unknown,
      name: string,
      kind: Exclude<DocumentKind, "pdf">,
    ) => boolean;
    reportWorkingCopyMissing: (name: string) => void;
  };
};
