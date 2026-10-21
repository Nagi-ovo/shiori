// Suspended PDF tabs: full editing sessions parked in IndexedDB so only a
// bounded number of tabs stay resident (`PDF_RESIDENT_LIMIT` in
// src/workspace/pdfRuntime.ts).
//
// Why not reuse drafts as the suspend carrier: drafts keep only the undo
// stack (no redo, tool, selection or clipboard), delete themselves when
// Undo returns the model to clean, trim history at 10 MB, and let their LRU
// evict any ID but the one being written. Suspending through drafts would
// make "undo to clean → suspend → wake" lose redo. So a suspended tab gets
// its own versioned snapshot plus a content-addressed, ref-counted PDF blob,
// written in one Dexie transaction. Passwords never reach IndexedDB; an
// encrypted PDF asks again after a restart.
//
// Failure policy (protected + bounded + never release before persisting
// contradict each other when quota is full; this resolves it):
// - Below the resident limit, admit without evicting.
// - At the limit, a new or woken tab waits for one successful eviction:
//   flush → commit → read back and verify → await `PDFDocumentProxy.destroy()`
//   → drop the runtime → mark suspended.
// - If the snapshot write fails, the tab stays resident, the new load or
//   wake is aborted, and the user is asked to close a tab or free storage.
// Resident count is a fixed LRU cap, not driven by memory-pressure signals
// (browsers have no reliable cross-platform one).

import type {
  DocumentModel,
  PageModel,
  ToolId,
} from "../pdf/model/types";
import type { LiveOverlayRevealItem } from "../live/overlayReveal";
import {
  type FitMode,
  type HistoryEntry,
  type PdfEditorStoreApi,
  type Store,
} from "../editor/store/store";
import type { DraftWriteVersion } from "./drafts";
import { observedDraftVersion } from "./draftVersions";
import { sha256Hex } from "./hash";
import { isQuotaExceededError, storageErrorMessage } from "./errors";
import { RUNTIME_PDF_BLOB_METADATA_INDEX, workspaceDb } from "./workspace";

export const SUSPENDED_PDF_SNAPSHOT_VERSION = 1 as const;
export const RUNTIME_SESSION_CAP_BYTES = 1024 * 1024 * 1024;
let runtimeSessionCapBytes = RUNTIME_SESSION_CAP_BYTES;

export type SuspendedPdfSnapshot = {
  version: typeof SUSPENDED_PDF_SNAPSHOT_VERSION;
  sourcePages: PageModel[];
  model: DocumentModel;
  tool: ToolId;
  scale: number;
  fitMode: FitMode;
  selectedIds: string[];
  activePageId: string | null;
  outlineSelection: Store["outlineSelection"];
  searchMatchHighlight: Store["searchMatchHighlight"];
  // No overlayClipboard: the clipboard is app-wide now. Snapshots stored
  // before that still carry one; it is ignored.
  editingOverlayId: string | null;
  collapsedNoteIds: string[];
  collapsedCalloutIds: string[];
  collapsedThreadIds: string[];
  undoStack: HistoryEntry[];
  redoStack: HistoryEntry[];
  completedLiveOperationIds: string[];
  pendingOverlayReveals: Array<[string, LiveOverlayRevealItem]>;
  textDefaults: Store["textDefaults"];
  showThumbs: boolean;
  readerMode: boolean;
  // The draft row the tab last read or wrote, so its next save can tell its
  // own row from one another window wrote meanwhile. Absent in snapshots
  // from older builds.
  draftVersion?: DraftWriteVersion | null;
};

export type RuntimeSessionRecord = {
  tabId: string;
  blobHash: string;
  snapshot: SuspendedPdfSnapshot;
  bytes: Uint8Array;
  lastTouched: number;
};

export class RuntimeSessionSaveError extends Error {
  readonly kind: "cap" | "quota" | "transient" | "verification";

  constructor(kind: RuntimeSessionSaveError["kind"], message: string) {
    super(message);
    this.name = "RuntimeSessionSaveError";
    this.kind = kind;
  }
}

const credentials = new Map<string, string>();
let beforeRuntimeWrite: (() => void | Promise<void>) | null = null;

export function captureSuspendedPdfSnapshot(
  store: PdfEditorStoreApi,
): SuspendedPdfSnapshot {
  const state = store.getState();
  return {
    version: SUSPENDED_PDF_SNAPSHOT_VERSION,
    sourcePages: state.opened?.sourcePages ?? state.model.pages,
    model: state.model,
    tool: state.tool,
    scale: state.scale,
    fitMode: state.fitMode,
    selectedIds: [...state.selectedIds],
    activePageId: state.activePageId,
    outlineSelection: state.outlineSelection
      ? { ...state.outlineSelection }
      : null,
    searchMatchHighlight: state.searchMatchHighlight
      ? { ...state.searchMatchHighlight }
      : null,
    editingOverlayId: state.editingOverlayId,
    collapsedNoteIds: [...state.collapsedNoteIds],
    collapsedCalloutIds: [...state.collapsedCalloutIds],
    collapsedThreadIds: [...state.collapsedThreadIds],
    undoStack: state.undoStack,
    redoStack: state.redoStack,
    completedLiveOperationIds: [...state.completedLiveOperationIds],
    pendingOverlayReveals: [...state.pendingOverlayReveals],
    textDefaults: { ...state.textDefaults },
    showThumbs: state.showThumbs,
    readerMode: state.readerMode,
    draftVersion: observedDraftVersion(state.opened, null),
  };
}

export function restoreSuspendedPdfSnapshot(
  store: PdfEditorStoreApi,
  snapshot: SuspendedPdfSnapshot,
): void {
  if (snapshot.version !== SUSPENDED_PDF_SNAPSHOT_VERSION) {
    throw new Error(`Unsupported suspended PDF snapshot: ${snapshot.version}`);
  }
  store.setState({
    ...(store.getState().opened
      ? {
          opened: {
            ...store.getState().opened!,
            sourcePages: snapshot.sourcePages,
          },
        }
      : {}),
    model: snapshot.model,
    tool: snapshot.tool,
    scale: snapshot.scale,
    fitMode: snapshot.fitMode,
    selectedIds: [...snapshot.selectedIds],
    activePageId: snapshot.activePageId,
    pageJump: null,
    outlineSelection: snapshot.outlineSelection
      ? { ...snapshot.outlineSelection }
      : null,
    searchMatchHighlight: snapshot.searchMatchHighlight
      ? { ...snapshot.searchMatchHighlight }
      : null,
    editingOverlayId: snapshot.editingOverlayId,
    collapsedNoteIds: [...snapshot.collapsedNoteIds],
    collapsedCalloutIds: [...snapshot.collapsedCalloutIds],
    collapsedThreadIds: [...snapshot.collapsedThreadIds],
    historyFeedback: null,
    liveOverlayReveals: [],
    pendingOverlayReveals: new Map(snapshot.pendingOverlayReveals),
    undoStack: snapshot.undoStack,
    redoStack: snapshot.redoStack,
    completedLiveOperationIds: new Set(snapshot.completedLiveOperationIds),
    // Font faces are loaded per session and must be rebuilt by the new doc.
    pdfFontFaces: {},
    pdfFontChars: {},
    textDefaults: { ...snapshot.textDefaults },
    showThumbs: snapshot.showThumbs,
    readerMode: snapshot.readerMode,
  });
}

export async function putRuntimeSession(input: {
  tabId: string;
  bytes: Uint8Array;
  snapshot: SuspendedPdfSnapshot;
  lastTouched?: number;
}): Promise<RuntimeSessionRecord> {
  const bytes = new Uint8Array(input.bytes);
  const blobHash = await sha256Hex(bytes);
  const lastTouched = input.lastTouched ?? Date.now();
  const snapshotSize = estimateStoredValueBytes(
    input.snapshot,
    runtimeSessionCapBytes,
  );
  if (snapshotSize > runtimeSessionCapBytes) {
    throw new RuntimeSessionSaveError(
      "cap",
      `Runtime PDF snapshot cap exceeded (${snapshotSize} bytes)`,
    );
  }
  try {
    await workspaceDb.transaction(
      "rw",
      workspaceDb.runtimeSessions,
      workspaceDb.runtimePdfBlobs,
      async () => {
        await beforeRuntimeWrite?.();
        const previous = await workspaceDb.runtimeSessions.get(input.tabId);
        const blobMetadata = await readRuntimeBlobMetadata();
        const existingBlob = blobMetadata.get(blobHash);
        // Even `.each()` clones every full PDF from IndexedDB. Scan index
        // keys instead so this work scales with tab count, not document bytes.
        let projected = snapshotSize;
        for (const row of blobMetadata.values()) {
          projected += row.size;
        }
        await workspaceDb.runtimeSessions.each((row) => {
          if (row.tabId === input.tabId) return;
          projected +=
            row.snapshotSize ??
            estimateStoredValueBytes(
              row.snapshot,
              Math.max(0, runtimeSessionCapBytes - projected),
            );
        });
        if (!existingBlob) projected += bytes.byteLength;
        if (previous && previous.blobHash !== blobHash) {
          const previousBlob = blobMetadata.get(previous.blobHash);
          if (previousBlob?.refCount === 1) projected -= previousBlob.size;
        }
        if (projected > runtimeSessionCapBytes) {
          throw new RuntimeSessionSaveError(
            "cap",
            `Runtime PDF storage cap exceeded (${projected} bytes)`,
          );
        }

        if (!previous || previous.blobHash !== blobHash) {
          await workspaceDb.runtimePdfBlobs.put({
            hash: blobHash,
            bytes,
            size: bytes.byteLength,
            refCount: (existingBlob?.refCount ?? 0) + 1,
          });
        } else if (!existingBlob) {
          await workspaceDb.runtimePdfBlobs.put({
            hash: blobHash,
            bytes,
            size: bytes.byteLength,
            refCount: 1,
          });
        }

        await workspaceDb.runtimeSessions.put({
          tabId: input.tabId,
          version: input.snapshot.version,
          blobHash,
          snapshot: input.snapshot,
          snapshotSize,
          lastTouched,
        });

        if (previous && previous.blobHash !== blobHash) {
          await decrementBlobReference(previous.blobHash);
        }
      },
    );
  } catch (error) {
    if (error instanceof RuntimeSessionSaveError) throw error;
    throw new RuntimeSessionSaveError(
      isQuotaExceededError(error) ? "quota" : "transient",
      storageErrorMessage(error),
    );
  }

  const verified = await readRuntimeSession(input.tabId);
  if (
    !verified ||
    verified.blobHash !== blobHash ||
    verified.bytes.byteLength !== bytes.byteLength ||
    (await sha256Hex(verified.bytes)) !== blobHash
  ) {
    throw new RuntimeSessionSaveError(
      "verification",
      "Runtime PDF session could not be verified after writing",
    );
  }
  return verified;
}

export async function readRuntimeSession(
  tabId: string,
): Promise<RuntimeSessionRecord | null> {
  const row = await workspaceDb.runtimeSessions.get(tabId);
  if (!row || !isSuspendedPdfSnapshot(row.snapshot)) return null;
  const blob = await workspaceDb.runtimePdfBlobs.get(row.blobHash);
  if (!blob || blob.refCount < 1 || blob.size !== blob.bytes.byteLength) {
    return null;
  }
  return {
    tabId,
    blobHash: row.blobHash,
    snapshot: row.snapshot,
    bytes: new Uint8Array(blob.bytes),
    lastTouched: row.lastTouched,
  };
}

export async function removeRuntimeSession(tabId: string): Promise<void> {
  await workspaceDb.transaction(
    "rw",
    workspaceDb.runtimeSessions,
    workspaceDb.runtimePdfBlobs,
    async () => {
      const row = await workspaceDb.runtimeSessions.get(tabId);
      if (!row) return;
      await workspaceDb.runtimeSessions.delete(tabId);
      await decrementBlobReference(row.blobHash);
    },
  );
  credentials.delete(tabId);
}

export async function repairRuntimeSessions(
  openWorkspaceTabIds: ReadonlySet<string>,
): Promise<void> {
  await workspaceDb.transaction(
    "rw",
    workspaceDb.runtimeSessions,
    workspaceDb.runtimePdfBlobs,
    async () => {
      // Cursor over full rows but retain metadata only. Snapshots and PDF
      // bytes can both be large; startup repair must have bounded peak memory.
      const retained: Array<{ tabId: string; blobHash: string }> = [];
      const staleIds: string[] = [];
      await workspaceDb.runtimeSessions.each((row) => {
        if (
          openWorkspaceTabIds.has(row.tabId) &&
          row.version === SUSPENDED_PDF_SNAPSHOT_VERSION &&
          isSuspendedPdfSnapshot(row.snapshot)
        ) {
          retained.push({ tabId: row.tabId, blobHash: row.blobHash });
        } else {
          staleIds.push(row.tabId);
        }
      });
      if (staleIds.length > 0) {
        await workspaceDb.runtimeSessions.bulkDelete(staleIds);
      }
      const refCounts = new Map<string, number>();
      for (const row of retained) {
        refCounts.set(row.blobHash, (refCounts.get(row.blobHash) ?? 0) + 1);
      }
      const blobs = await readRuntimeBlobMetadata();
      for (const [hash, blob] of blobs) {
        const refCount = refCounts.get(hash) ?? 0;
        if (refCount === 0) {
          await workspaceDb.runtimePdfBlobs.delete(hash);
        } else if (blob.refCount !== refCount) {
          await workspaceDb.runtimePdfBlobs.update(hash, { refCount });
        }
      }
      const missingBlobSessions = retained
        .filter((row) => !blobs.has(row.blobHash))
        .map((row) => row.tabId);
      if (missingBlobSessions.length > 0) {
        await workspaceDb.runtimeSessions.bulkDelete(missingBlobSessions);
      }
    },
  );
}

export async function runtimeSessionStorageBytes(): Promise<number> {
  let total = 0;
  for (const row of (await readRuntimeBlobMetadata()).values()) {
    total += row.size;
  }
  await workspaceDb.runtimeSessions.each((row) => {
    total += row.snapshotSize ?? estimateStoredValueBytes(row.snapshot);
  });
  return total;
}

async function readRuntimeBlobMetadata(): Promise<Map<string, { size: number; refCount: number }>> {
  const metadata = new Map<string, { size: number; refCount: number }>();
  await workspaceDb.runtimePdfBlobs.orderBy(RUNTIME_PDF_BLOB_METADATA_INDEX).eachKey((key) => {
    const [hash, size, refCount] = key as [string, number, number];
    metadata.set(hash, { size, refCount });
  });
  return metadata;
}

export function rememberRuntimeCredential(tabId: string, password?: string): void {
  if (password) credentials.set(tabId, password);
  else credentials.delete(tabId);
}

export function runtimeCredential(tabId: string): string | undefined {
  return credentials.get(tabId);
}

function isSuspendedPdfSnapshot(value: unknown): value is SuspendedPdfSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Record<string, unknown>;
  return (
    snapshot.version === SUSPENDED_PDF_SNAPSHOT_VERSION &&
    Array.isArray(snapshot.sourcePages) &&
    typeof snapshot.model === "object" &&
    Array.isArray(snapshot.selectedIds) &&
    Array.isArray(snapshot.collapsedNoteIds) &&
    Array.isArray(snapshot.collapsedCalloutIds) &&
    Array.isArray(snapshot.collapsedThreadIds) &&
    Array.isArray(snapshot.undoStack) &&
    Array.isArray(snapshot.redoStack) &&
    Array.isArray(snapshot.completedLiveOperationIds) &&
    Array.isArray(snapshot.pendingOverlayReveals)
  );
}

/**
 * Conservative, allocation-bounded estimate of an IndexedDB structured clone.
 * Shared object identities are counted once, matching structured clone's
 * back-reference behaviour; strings use UTF-16 width so image data URLs and
 * text history cannot hide behind the PDF-blob-only quota.
 */
function estimateStoredValueBytes(
  root: unknown,
  stopAfter = Number.POSITIVE_INFINITY,
): number {
  const stack: unknown[] = [root];
  const seen = new WeakSet<object>();
  let total = 0;
  while (stack.length > 0 && total <= stopAfter) {
    const value = stack.pop();
    if (value == null) {
      total += 4;
      continue;
    }
    if (typeof value === "string") {
      total += value.length * 2 + 8;
      continue;
    }
    if (typeof value === "number" || typeof value === "bigint") {
      total += 8;
      continue;
    }
    if (typeof value === "boolean") {
      total += 4;
      continue;
    }
    if (typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    total += 16;
    if (ArrayBuffer.isView(value)) {
      total += value.byteLength;
      continue;
    }
    if (value instanceof ArrayBuffer) {
      total += value.byteLength;
      continue;
    }
    if (value instanceof Map) {
      for (const [key, entry] of value) stack.push(key, entry);
      continue;
    }
    if (value instanceof Set) {
      for (const entry of value) stack.push(entry);
      continue;
    }
    for (const key in value as Record<string, unknown>) {
      total += key.length * 2 + 4;
      stack.push((value as Record<string, unknown>)[key]);
    }
  }
  return total;
}

async function decrementBlobReference(hash: string): Promise<void> {
  const blob = await workspaceDb.runtimePdfBlobs.get(hash);
  if (!blob) return;
  if (blob.refCount <= 1) {
    await workspaceDb.runtimePdfBlobs.delete(hash);
  } else {
    await workspaceDb.runtimePdfBlobs.update(hash, {
      refCount: blob.refCount - 1,
    });
  }
}

export const __runtimeSessionTest = {
  setCapBytes(value: number | undefined) {
    runtimeSessionCapBytes = value ?? RUNTIME_SESSION_CAP_BYTES;
  },
  setBeforeWrite(hook: (() => void | Promise<void>) | null) {
    beforeRuntimeWrite = hook;
  },
  clearCredentials() {
    credentials.clear();
  },
};
