import Dexie, { type Table } from "dexie";
import { nanoid } from "nanoid";
import type { DocumentKind, DocumentSource } from "../documents/types";
import type { FitMode, RailTab } from "../editor/store/store";
import type { MarkdownAppearanceOverride } from "../documents/markdownAppearance";
import { isQuotaExceededError, storageErrorMessage } from "./errors";
import { isWorkspaceTabMeta, migrateTabMeta } from "./workspaceTabMeta";

export const WORKSPACE_SOURCE_CAP_BYTES = 512 * 1024 * 1024;
let workspaceSourceCapBytes = WORKSPACE_SOURCE_CAP_BYTES;
const WORKSPACE_KEY = "shiori:workspace:v1";
const SOURCE_AGE_INDEX = "[savedAt+size+id]";
export const TAB_PREVIEW_AGE_INDEX = "[capturedAt+size+tabId]";
export const RUNTIME_PDF_BLOB_METADATA_INDEX = "[hash+size+refCount]";

export type WorkspacePdfViewState = {
  pageIndex: number;
  scale: number;
  fitMode: FitMode;
  showThumbs: boolean;
  showRail: boolean;
  railTab: RailTab;
  readerMode: boolean;
  /** Presentation-only note disclosure state; never part of the PDF model. */
  collapsedNoteIds?: string[];
  /** Same, for callouts. */
  collapsedCalloutIds?: string[];
};

export type WorkspaceTextViewState = {
  scrollTop: number;
  zoom?: number;
  mode?: WorkspaceTextViewMode;
  appearance?: MarkdownAppearanceOverride;
};

export type WorkspaceTextViewMode = "preview" | "edit";

export function patchWorkspaceTextView(
  current: WorkspaceTextViewState | undefined,
  patch: Partial<WorkspaceTextViewState>,
): WorkspaceTextViewState {
  const next: WorkspaceTextViewState = {
    scrollTop: 0,
    ...current,
    ...patch,
  };
  if (next.zoom === undefined || next.zoom === 1) delete next.zoom;
  if (next.mode === undefined || next.mode === "preview") delete next.mode;
  if (next.appearance && Object.keys(next.appearance).length === 0) {
    delete next.appearance;
  }
  return next;
}

export type WorkspaceTabMeta = {
  id: string;
  kind: DocumentKind;
  title: string;
  size: number;
  source: DocumentSource;
  // Text documents keep their original path/file-handle source for relative
  // resources and identity while edits autosave into this app-local working
  // copy. The working copy is always preferred when restoring the tab.
  workingCopyCacheId?: string;
  // Text documents only: there are edits in the working copy that have not
  // been written back to the file the tab was opened from. Persisted so the
  // unsaved marker — and the warning on close — survive a restart, exactly
  // like `exportBaselineSnapshot` does for PDFs.
  textDirty?: boolean;
  hash?: string;
  /**
   * Text documents only: SHA-256 of what the file held when Shiori last read
   * or wrote it. Cmd+S first checks the file still holds that, so it never
   * replaces a newer version another program wrote. Persisted so edits
   * restored from the working copy keep it; unknown (undefined) means the
   * save asks first.
   */
  sourceHash?: string;
  /**
   * Explicitly kept: this document is part of what the reader is working on,
   * not just something they opened to look at. Opening a file never sets it —
   * the reader does, with the pin control. Absent means unfiled.
   *
   * Deliberately not a heuristic. An earlier design promoted a file after ten
   * seconds of reading or its first annotation; a rule the reader cannot see
   * is a rule they cannot predict.
   */
  pinned?: boolean;
  pdfView?: WorkspacePdfViewState;
  textView?: WorkspaceTextViewState;
  // Export bookkeeping, persisted so the "not exported yet" marker survives a
  // restart. Without it a tab that WAS exported came back looking unexported
  // and warned on close, while a tab with real unexported edits looked clean.
  exportBaselineSnapshot?: string | null;
  lastExport?: WorkspaceExportedSnapshot | null;
  updatedAt: number;
};

// Structural mirror of ExportedSnapshot in editor/export/exportStatus. Kept
// local so the storage layer does not depend on the editor.
export type WorkspaceExportedSnapshot = {
  documentHash: string;
  snapshotKey: string;
  exportedAt: number;
  path: string;
  platform: "desktop" | "web" | "mobile";
};

export type WorkspaceState = {
  version: 1;
  activeTabId: string | null;
  tabs: WorkspaceTabMeta[];
  /**
   * Mounted workspace roots. Only their paths are stored; listings are read
   * fresh from disk. A workspace can contain several independent folders.
   *
   * Desktop only: no other platform can list a directory.
   */
  folderPaths?: string[];
};

export type WorkspaceSourceBlob = {
  id: string;
  kind: DocumentKind;
  name: string;
  size: number;
  bytes: Uint8Array;
  savedAt: number;
};

type WorkspaceSourceMetadata = Pick<
  WorkspaceSourceBlob,
  "id" | "savedAt" | "size"
>;

export type StoredRuntimeSessionRow = {
  tabId: string;
  version: number;
  blobHash: string;
  snapshot: unknown;
  /** Conservative structured-clone footprint used by the runtime LRU cap. */
  snapshotSize?: number;
  lastTouched: number;
};

export type StoredRuntimePdfBlob = {
  hash: string;
  bytes: Uint8Array;
  size: number;
  refCount: number;
};

export type StoredTabPreviewRow = {
  tabId: string;
  imageUrl: string;
  pageNumber: number;
  scale: number;
  capturedAt: number;
  size: number;
};

export class WorkspaceSourceSaveError extends Error {
  readonly kind: "quota" | "transient";

  constructor(kind: "quota" | "transient", message: string) {
    super(message);
    this.name = "WorkspaceSourceSaveError";
    this.kind = kind;
  }
}

class WorkspaceDb extends Dexie {
  sources!: Table<WorkspaceSourceBlob, string>;
  runtimeSessions!: Table<StoredRuntimeSessionRow, string>;
  runtimePdfBlobs!: Table<StoredRuntimePdfBlob, string>;
  tabPreviews!: Table<StoredTabPreviewRow, string>;

  constructor() {
    super("shiori-workspace");
    this.version(1).stores({
      sources: "id, savedAt",
    });
    this.version(2).stores({
      sources: "id, savedAt",
      runtimeSessions: "tabId, lastTouched, blobHash",
      runtimePdfBlobs: "hash",
    });
    this.version(3).stores({
      // Quota checks only need these three scalar fields. Keeping them in one
      // compound index lets IndexedDB return LRU metadata without cloning each
      // cached document's potentially hundreds of megabytes of `bytes`.
      sources: `id, savedAt, ${SOURCE_AGE_INDEX}`,
      runtimeSessions: "tabId, lastTouched, blobHash",
      runtimePdfBlobs: "hash",
    });
    this.version(4).stores({
      sources: `id, savedAt, ${SOURCE_AGE_INDEX}`,
      runtimeSessions: "tabId, lastTouched, blobHash",
      runtimePdfBlobs: "hash",
      tabPreviews: "tabId, capturedAt",
    });
    this.version(5).stores({
      sources: `id, savedAt, ${SOURCE_AGE_INDEX}`,
      runtimeSessions: "tabId, lastTouched, blobHash",
      runtimePdfBlobs: "hash",
      // The compound key carries all eviction metadata. IndexedDB can scan it
      // without cloning every preview's comparatively large data URL.
      tabPreviews: `tabId, capturedAt, ${TAB_PREVIEW_AGE_INDEX}`,
    });
    this.version(6).stores({
      sources: `id, savedAt, ${SOURCE_AGE_INDEX}`,
      runtimeSessions: "tabId, lastTouched, blobHash",
      // IndexedDB builds this index for existing rows during the upgrade.
      // Quota checks and startup repair can read scalar keys without cloning
      // the complete PDF bytes for every suspended tab.
      runtimePdfBlobs: `hash, ${RUNTIME_PDF_BLOB_METADATA_INDEX}`,
      tabPreviews: `tabId, capturedAt, ${TAB_PREVIEW_AGE_INDEX}`,
    });
  }
}

const db = new WorkspaceDb();
export const workspaceDb = db;

export function loadWorkspaceState(): WorkspaceState {
  if (typeof localStorage === "undefined") return emptyWorkspaceState();
  try {
    const raw = localStorage.getItem(WORKSPACE_KEY);
    if (!raw) return emptyWorkspaceState();
    const parsed = JSON.parse(raw) as Partial<WorkspaceState> & {
      /** v1 initially persisted a single root before multi-root was restored. */
      folderPath?: unknown;
    };
    if (parsed.version !== 1 || !Array.isArray(parsed.tabs)) {
      return emptyWorkspaceState();
    }
    const tabs = parsed.tabs.filter(isWorkspaceTabMeta).map(migrateTabMeta);
    // `null` is a real answer, not a missing one: the user went Home with tabs
    // still open and quit there. Folding it in with "absent" reopened the
    // first tab on the next launch — re-reading its bytes and possibly raising
    // a draft-recovery prompt — instead of the home screen they left on.
    // Anything else unrecognised still falls back to the first tab.
    const savedActiveTabId = parsed.activeTabId;
    const activeTabId =
      savedActiveTabId === null
        ? null
        : typeof savedActiveTabId === "string" &&
            tabs.some((tab) => tab.id === savedActiveTabId)
          ? savedActiveTabId
          : tabs[0]?.id ?? null;
    const folderPaths = Array.isArray(parsed.folderPaths)
      ? normalizeFolderPaths(parsed.folderPaths)
      : normalizeFolderPaths([parsed.folderPath]);
    return {
      version: 1,
      activeTabId,
      tabs,
      ...(folderPaths.length > 0 ? { folderPaths } : {}),
    };
  } catch {
    return emptyWorkspaceState();
  }
}

export function saveWorkspaceState(state: WorkspaceState): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    const folderPaths = normalizeFolderPaths(state.folderPaths ?? []);
    localStorage.setItem(
      WORKSPACE_KEY,
      JSON.stringify({
        version: state.version,
        activeTabId: state.activeTabId,
        tabs: state.tabs.map(migrateTabMeta),
        ...(folderPaths.length > 0 ? { folderPaths } : {}),
      } satisfies WorkspaceState),
    );
    return true;
  } catch {
    return false;
  }
}

function normalizeFolderPaths(value: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "string" || candidate.length === 0) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    result.push(candidate);
  }
  return result;
}

export function clearWorkspaceState(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(WORKSPACE_KEY);
  } catch {
    // ignore
  }
}

export async function putWorkspaceSource(
  source: Omit<WorkspaceSourceBlob, "id" | "savedAt"> & {
    id?: string;
    savedAt?: number;
  },
  protectedIds: Set<string> = new Set(),
): Promise<string> {
  const id = source.id ?? nanoid();
  const savedAt = source.savedAt ?? Date.now();
  const row: WorkspaceSourceBlob = {
    id,
    kind: source.kind,
    name: source.name,
    size: source.bytes.byteLength,
    bytes: new Uint8Array(source.bytes),
    savedAt,
  };
  try {
    await admitWorkspaceSource(id, row.size, protectedIds);
  } catch (error) {
    if (error instanceof WorkspaceSourceSaveError) throw error;
    throw new WorkspaceSourceSaveError("transient", storageErrorMessage(error));
  }
  const write = () => db.sources.put(row);
  try {
    await write();
  } catch (error) {
    if (!isQuotaExceededError(error)) {
      throw new WorkspaceSourceSaveError(
        "transient",
        storageErrorMessage(error),
      );
    }
    await evictSourcesAfterQuotaFailure(
      new Set([...protectedIds, id]),
      row.size,
    );
    try {
      await write();
    } catch (retryError) {
      throw new WorkspaceSourceSaveError(
        isQuotaExceededError(retryError) ? "quota" : "transient",
        storageErrorMessage(retryError),
      );
    }
  }
  try {
    await enforceSourceQuota(new Set([...protectedIds, id]));
  } catch (error) {
    // The source is already durable. A cleanup failure must not make callers
    // discard a valid cache id and report the successful write as lost.
    console.warn("Workspace source quota sweep failed after save", error);
  }
  return id;
}

export async function getWorkspaceSource(
  id: string,
): Promise<WorkspaceSourceBlob | undefined> {
  const source = await db.sources.get(id);
  return source
    ? { ...source, bytes: new Uint8Array(source.bytes) }
    : undefined;
}

export async function removeWorkspaceSource(id: string): Promise<void> {
  await db.sources.delete(id);
}

export async function cleanupWorkspaceSources(
  protectedIds: Set<string>,
): Promise<void> {
  const rows = await sourceMetadataByAge();
  const stale = rows
    .filter((source) => !protectedIds.has(source.id))
    .map((source) => source.id);
  if (stale.length > 0) await db.sources.bulkDelete(stale);
  await enforceSourceQuota(protectedIds);
}

export async function totalWorkspaceSourceBytes(): Promise<number> {
  const rows = await sourceMetadataByAge();
  return rows.reduce((sum, row) => sum + row.size, 0);
}

function emptyWorkspaceState(): WorkspaceState {
  return { version: 1, activeTabId: null, tabs: [] };
}

async function evictSourcesAfterQuotaFailure(
  protectedIds: Set<string>,
  incomingBytes: number,
): Promise<void> {
  const rows = await sourceMetadataByAge();
  const stored = rows.reduce((sum, row) => sum + row.size, 0);
  const byAppCap = Math.floor(workspaceSourceCapBytes * 0.8) - incomingBytes;
  let byBrowserQuota = Number.POSITIVE_INFINITY;
  try {
    const quota =
      typeof navigator === "undefined"
        ? undefined
        : (await navigator.storage?.estimate?.())?.quota;
    if (typeof quota === "number" && quota > 0) {
      byBrowserQuota = Math.floor(quota * 0.8) - incomingBytes;
    }
  } catch {
    // The progress floor still guarantees that a real retry frees space.
  }
  const target = Math.max(
    0,
    Math.min(byAppCap, byBrowserQuota, Math.floor(stored * 0.8)),
  );
  await enforceSourceQuota(protectedIds, target, rows);
}

async function admitWorkspaceSource(
  id: string,
  incomingBytes: number,
  protectedIds: Set<string>,
): Promise<void> {
  if (incomingBytes > workspaceSourceCapBytes) {
    throw new WorkspaceSourceSaveError(
      "quota",
      "Document exceeds the workspace source cap",
    );
  }
  const rows = await sourceMetadataByAge();
  const protectedBytes = rows.reduce(
    (sum, row) =>
      row.id !== id && protectedIds.has(row.id) ? sum + row.size : sum,
    0,
  );
  if (protectedBytes > workspaceSourceCapBytes - incomingBytes) {
    throw new WorkspaceSourceSaveError(
      "quota",
      "Open documents already occupy the workspace source cap",
    );
  }
  await enforceSourceQuota(
    protectedIds,
    workspaceSourceCapBytes - incomingBytes,
    rows,
  );
}

async function enforceSourceQuota(
  protectedIds: Set<string>,
  targetBytes = workspaceSourceCapBytes,
  rows?: readonly WorkspaceSourceMetadata[],
): Promise<void> {
  const metadata = rows ?? (await sourceMetadataByAge());
  let total = metadata.reduce((sum, row) => sum + row.size, 0);
  if (total <= targetBytes) return;
  for (const row of metadata) {
    if (total <= targetBytes) break;
    if (protectedIds.has(row.id)) continue;
    await db.sources.delete(row.id);
    total -= row.size;
  }
}

async function sourceMetadataByAge(): Promise<WorkspaceSourceMetadata[]> {
  const keys = await db.sources.orderBy(SOURCE_AGE_INDEX).keys();
  return keys.map((key) => {
    if (
      !Array.isArray(key) ||
      key.length !== 3 ||
      typeof key[0] !== "number" ||
      typeof key[1] !== "number" ||
      typeof key[2] !== "string"
    ) {
      throw new Error("Invalid workspace source metadata index");
    }
    return { savedAt: key[0], size: key[1], id: key[2] };
  });
}

export const workspaceStorage = {
  loadWorkspaceState,
  saveWorkspaceState,
  clearWorkspaceState,
  putWorkspaceSource,
  getWorkspaceSource,
  removeWorkspaceSource,
  cleanupWorkspaceSources,
  totalWorkspaceSourceBytes,
};

export const __workspaceTest = {
  db,
  setSourceCapBytes(capBytes: number | undefined) {
    workspaceSourceCapBytes = capBytes ?? WORKSPACE_SOURCE_CAP_BYTES;
  },
  async reset() {
    clearWorkspaceState();
    await db.transaction(
      "rw",
      db.sources,
      db.runtimeSessions,
      db.runtimePdfBlobs,
      db.tabPreviews,
      async () => {
        await Promise.all([
          db.sources.clear(),
          db.runtimeSessions.clear(),
          db.runtimePdfBlobs.clear(),
          db.tabPreviews.clear(),
        ]);
      },
    );
    workspaceSourceCapBytes = WORKSPACE_SOURCE_CAP_BYTES;
  },
};
