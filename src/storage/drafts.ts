import type Dexie from "dexie";
import type { HistoryEntry } from "../editor/store/store";
import {
  db,
  estimateDraftStorage,
  estimateJsonSize,
  notifyChanged,
  subscribe,
  toUint8,
  type Draft,
} from "./draftsDb";
import {
  clearAllOperationLogs,
  clearOperationLog,
  pruneOperationLogs,
} from "./operationLog";
import {
  assertSha256Hex,
  isSha256Hex,
  LIVE_OPERATION_LEDGER_MAX_BYTES,
  LIVE_OPERATION_RECEIPT_MAX,
} from "../live/liveReceiptPolicy";
import {
  isQuotaExceededError,
  storageErrorMessage,
} from "./errors";
import { sanitizeHistory } from "./draftValidation";
import {
  enforceQuota,
  evictAfterQuotaFailure,
  legacyDraftBytesById,
} from "./draftEviction";
import {
  clearEvictionNotices,
  getEvictionNotices,
  recordEvictions,
} from "./draftEvictionNotices";

export { subscribe, type Draft } from "./draftsDb";
export {
  clearEvictionNotices,
  getEvictionNotices,
  type EvictionNotice,
} from "./draftEvictionNotices";
export {
  LIVE_OPERATION_LEDGER_MAX_BYTES,
  LIVE_OPERATION_RECEIPT_MAX,
} from "../live/liveReceiptPolicy";

export const CAP_BYTES = 1024 * 1024 * 1024; // 1 GB total
// Cross-session undo: cap the persisted history at this many snapshots…
export const HISTORY_MAX_STEPS = 50;
// …and at this serialized size, whichever is hit first. The byte guard exists
// because snapshots are full-model copies: one overlay with a large inline
// payload (today: a signature dataUrl) repeats in every snapshot, so a single
// ~200 KB signature turns 50 steps into ~10 MB. Until images move to
// content-addressed blob references, the guard trades history depth for a
// bounded record instead of letting one draft eat the quota.
export const HISTORY_MAX_BYTES = 10 * 1024 * 1024;
let capBytesOverrideForTest: number | undefined;
let ledgerCapBytesOverrideForTest: number | undefined;
let persistentStorageAsked = false;

export type DraftWriteVersion = {
  lastTouched: number;
  revision: string | null;
};

export type DraftMeta = Omit<
  Draft,
  "pdfBytes" | "model" | "history" | "completedLiveOperationIds"
> & {
  storageBytes: number;
};

export class DraftSaveError extends Error {
  kind: "quota" | "transient";

  constructor(
    kind: "quota" | "transient",
    message: string,
  ) {
    super(message);
    this.name = "DraftSaveError";
    this.kind = kind;
  }
}

function createDraftRevision(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// Serialized size of a history snapshot, cached by object identity.
//
// A HistoryEntry is immutable once pushed, but trimHistory re-measured up to
// HISTORY_MAX_STEPS (50) of them on EVERY autosave — a full JSON.stringify
// each — and autosave runs while the user types. With a signature dataUrl in
// the model (~200 KB, repeated in every snapshot) that was on the order of
// 10 MB of stringify per save, on the main thread, producing exactly the
// keystroke latency and ink-drawing jank you would expect on the documents
// where losing work matters most.
//
// A WeakMap keyed on the entry means an unchanged snapshot is measured once
// for its lifetime and collected with it; only the newest entry is ever new.
const historySizeCache = new WeakMap<object, number>();

function historyEntrySize(entry: HistoryEntry | undefined): number {
  if (!entry || typeof entry !== "object") return estimateJsonSize(entry);
  const cached = historySizeCache.get(entry);
  if (cached !== undefined) return cached;
  const size = estimateJsonSize(entry);
  historySizeCache.set(entry, size);
  return size;
}

function receiptRecordSize(id: string, operationIds: string[]): number {
  return estimateJsonSize({ id, operationIds }) + 128;
}

function ledgerCapBytes(): number {
  return ledgerCapBytesOverrideForTest ?? LIVE_OPERATION_LEDGER_MAX_BYTES;
}

// Keep the newest top-level history groups that fit within both limits;
// older groups fall off first. Returns the kept slice
// (still oldest-first) plus its serialized size for quota accounting.
function trimHistory(history: HistoryEntry[]): {
  history: HistoryEntry[];
  byteLength: number;
} {
  const kept: HistoryEntry[] = [];
  let total = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (kept.length >= HISTORY_MAX_STEPS) break;
    const size = historyEntrySize(history[i]);
    // An unserializable snapshot would also fail the IndexedDB write later;
    // dropping it (and everything older) beats poisoning the whole record.
    if (size === 0) break;
    if (total + size > HISTORY_MAX_BYTES) break;
    total += size;
    kept.push(history[i]!);
  }
  kept.reverse();
  return { history: kept, byteLength: total };
}

function sanitizeLiveOperationReceipts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const unique = new Set<string>();
  for (const entry of value) {
    if (isSha256Hex(entry)) {
      unique.add(entry);
    }
  }
  return [...unique].slice(-LIVE_OPERATION_RECEIPT_MAX);
}

/** Read idempotency tombstones without creating a recoverable draft. */
export async function getLiveOperationReceipts(id: string): Promise<string[]> {
  assertSha256Hex(id, "PDF hash");
  const record = await db.liveOperationReceipts.get(id);
  if (!record || record.id !== id) return [];
  return sanitizeLiveOperationReceipts(record.operationIds);
}

async function enforceLiveOperationLedgerQuota(
  protectId?: string,
): Promise<void> {
  const rows = await db.liveOperationReceipts.orderBy("lastTouched").toArray();
  let total = rows.reduce(
    (sum, row) =>
      sum +
      (Number.isSafeInteger(row.storageBytes) && row.storageBytes > 0
        ? row.storageBytes
        : receiptRecordSize(
            row.id,
            sanitizeLiveOperationReceipts(row.operationIds),
          )),
    0,
  );
  const cap = ledgerCapBytes();
  if (total <= cap) return;
  await db.transaction("rw", db.liveOperationReceipts, async () => {
    for (const row of rows) {
      if (total <= cap) break;
      if (row.id === protectId) continue;
      await db.liveOperationReceipts.delete(row.id);
      total -=
        Number.isSafeInteger(row.storageBytes) && row.storageBytes > 0
          ? row.storageBytes
          : receiptRecordSize(
              row.id,
              sanitizeLiveOperationReceipts(row.operationIds),
            );
    }
  });
}

/**
 * Merge successful-operation receipts for one source PDF. Inputs are rejected,
 * not coerced: this ledger is a security boundary used to suppress mutation.
 */
export async function mergeLiveOperationReceipts(
  id: string,
  operationIds: readonly string[],
): Promise<void> {
  assertSha256Hex(id, "PDF hash");
  if (operationIds.length > LIVE_OPERATION_RECEIPT_MAX) {
    throw new RangeError(
      `Receipt batch cannot exceed ${LIVE_OPERATION_RECEIPT_MAX} operation ids`,
    );
  }
  for (const operationId of operationIds) {
    assertSha256Hex(operationId, "Live operation id");
  }
  if (operationIds.length === 0) return;

  const lastTouched = Date.now();
  await db.transaction("rw", db.liveOperationReceipts, async () => {
    const existing = await db.liveOperationReceipts.get(id);
    const merged = new Set(
      sanitizeLiveOperationReceipts(existing?.operationIds),
    );
    for (const operationId of operationIds) merged.add(operationId);
    const bounded = [...merged].slice(-LIVE_OPERATION_RECEIPT_MAX);
    await db.liveOperationReceipts.put({
      id,
      operationIds: bounded,
      lastTouched,
      storageBytes: receiptRecordSize(id, bounded),
    });
  });
  await enforceLiveOperationLedgerQuota(id);
  void requestPersistentStorage();
  notifyChanged();
}

export async function putLiveOperationReceipt(
  id: string,
  operationId: string,
): Promise<void> {
  await mergeLiveOperationReceipts(id, [operationId]);
}

export async function removeLiveOperationReceipts(id: string): Promise<void> {
  assertSha256Hex(id, "PDF hash");
  await db.liveOperationReceipts.delete(id);
  notifyChanged();
}

function quotaCapBytes(): number {
  return capBytesOverrideForTest ?? CAP_BYTES;
}

export async function requestPersistentStorage(): Promise<void> {
  if (persistentStorageAsked) return;
  persistentStorageAsked = true;
  try {
    const storage = navigator.storage;
    if (!storage?.persist || !storage.persisted) return;
    if (!(await storage.persisted())) {
      await storage.persist();
    }
  } catch {
    // Persistence is best-effort. Autosave must never depend on this prompt.
  }
}

export async function get(id: string): Promise<Draft | undefined> {
  const [model, blob] = await Promise.all([
    db.draftModels.get(id),
    db.pdfBlobs.get(id),
  ]);
  if (model && blob) {
    return {
      id,
      fileName: model.fileName,
      fileSize: model.fileSize,
      pdfBytes: toUint8(blob.bytes),
      model: model.model,
      history: sanitizeHistory(model.history),
      completedLiveOperationIds: sanitizeLiveOperationReceipts(
        model.completedLiveOperationIds,
      ),
      createdAt: model.createdAt,
      lastTouched: model.lastTouched,
      revision: model.revision,
    };
  }

  // Compatibility fallback if a v1 row exists but v2 tables were not populated.
  const legacy = await db.drafts.get(id);
  if (!legacy) return undefined;
  return {
    ...legacy,
    history: [],
    completedLiveOperationIds: sanitizeLiveOperationReceipts(
      legacy.completedLiveOperationIds,
    ),
    pdfBytes: toUint8(legacy.pdfBytes),
  };
}

export async function list(): Promise<DraftMeta[]> {
  const rows = await db.draftModels.orderBy("lastTouched").reverse().toArray();
  return rows.map((row) => ({
    id: row.id,
    fileName: row.fileName,
    fileSize: row.fileSize,
    createdAt: row.createdAt,
    lastTouched: row.lastTouched,
    storageBytes: row.storageBytes,
  }));
}

async function legacyDraftBytes(): Promise<number> {
  const sizes = await legacyDraftBytesById();
  let total = 0;
  for (const size of sizes.values()) total += size;
  return total;
}

export async function totalBytes(): Promise<number> {
  const [draftRows, receiptRows, legacyBytes] = await Promise.all([
    db.draftModels.toArray(),
    db.liveOperationReceipts.toArray(),
    legacyDraftBytes(),
  ]);
  return (
    draftRows.reduce((total, row) => total + row.storageBytes, 0) +
    receiptRows.reduce(
      (total, row) =>
        total +
        (Number.isSafeInteger(row.storageBytes) && row.storageBytes > 0
          ? row.storageBytes
          : receiptRecordSize(
              row.id,
              sanitizeLiveOperationReceipts(row.operationIds),
            )),
      0,
    ) +
    legacyBytes
  );
}

// Upsert a draft. Preserves createdAt if an entry with this id already exists;
// always bumps lastTouched. Original PDF bytes are written once per hash, then
// later autosaves update only the model-sized row and small metadata fields.
export async function put(
  incoming: Omit<
    Draft,
    "createdAt" | "history" | "completedLiveOperationIds"
  > & {
    createdAt?: number;
    history?: HistoryEntry[];
    completedLiveOperationIds?: string[];
  },
): Promise<DraftWriteVersion> {
  const now = Date.now();
  const revision = createDraftRevision();
  const pdfByteLength = incoming.pdfBytes.byteLength;
  const modelByteLength = estimateJsonSize(incoming.model);
  const { history, byteLength: historyByteLength } = trimHistory(
    incoming.history ?? [],
  );
  const completedLiveOperationIds = sanitizeLiveOperationReceipts(
    incoming.completedLiveOperationIds,
  );
  const receiptByteLength = estimateJsonSize(completedLiveOperationIds);
  const storageBytes = estimateDraftStorage(
    pdfByteLength,
    modelByteLength + historyByteLength + receiptByteLength,
  );
  const writeDraft = async () => db.transaction("rw", db.pdfBlobs, db.draftModels, async () => {
    // Read and conditionally write under the same transaction. An eviction or
    // clear running between an earlier read and this write must not leave a
    // model row whose supposedly-existing source blob was actually deleted.
    const [existingModel, existingBlob] = await Promise.all([
      db.draftModels.get(incoming.id),
      db.pdfBlobs.get(incoming.id),
    ]);
    const createdAt =
      existingModel?.createdAt ??
      existingBlob?.createdAt ??
      incoming.createdAt ??
      now;
    if (!existingBlob) {
      await db.pdfBlobs.put({
        id: incoming.id,
        fileName: incoming.fileName,
        fileSize: incoming.fileSize,
        bytes: toUint8(incoming.pdfBytes),
        createdAt,
      });
    } else if (
      existingBlob.fileName !== incoming.fileName ||
      existingBlob.fileSize !== incoming.fileSize
    ) {
      await db.pdfBlobs.update(incoming.id, {
        fileName: incoming.fileName,
        fileSize: incoming.fileSize,
      });
    }
    await db.draftModels.put({
      id: incoming.id,
      fileName: incoming.fileName,
      fileSize: incoming.fileSize,
      model: incoming.model,
      history,
      completedLiveOperationIds,
      createdAt,
      lastTouched: incoming.lastTouched,
      revision,
      pdfByteLength,
      modelByteLength,
      historyByteLength,
      storageBytes,
    });
  });
  try {
    await writeDraft();
  } catch (err) {
    if (!isQuotaExceededError(err)) {
      throw new DraftSaveError("transient", storageErrorMessage(err));
    }
    await evictAfterQuotaFailure(quotaCapBytes(), incoming.id, storageBytes);
    try {
      await writeDraft();
    } catch (retryErr) {
      throw new DraftSaveError(
        isQuotaExceededError(retryErr) ? "quota" : "transient",
        storageErrorMessage(retryErr),
      );
    }
  }
  try {
    await enforceQuota(quotaCapBytes(), incoming.id);
  } catch (err) {
    // The draft row is already durably written at this point; a failing LRU
    // sweep must not be reported as a lost save.
    console.warn("Draft quota sweep failed after a successful save", err);
  }
  void requestPersistentStorage();
  notifyChanged();
  return { lastTouched: incoming.lastTouched, revision };
}

async function removeDraftData(id: string): Promise<void> {
  await db.transaction("rw", db.drafts, db.pdfBlobs, db.draftModels, async () => {
    await Promise.all([
      db.drafts.delete(id),
      db.pdfBlobs.delete(id),
      db.draftModels.delete(id),
    ]);
  });
  clearOperationLog(id);
}

/** Automatic clean-baseline path: remove recovery data but retain tombstones. */
export async function removeDraftPreservingLiveOperationReceipts(
  id: string,
): Promise<void> {
  await removeDraftData(id);
  notifyChanged();
}

/**
 * Remove a clean-baseline draft only when it is still the exact row this
 * editor session observed or wrote. IndexedDB serializes this read/delete
 * transaction across browser tabs, so a newer writer cannot be deleted
 * between the comparison and the delete.
 */
export async function removeDraftPreservingLiveOperationReceiptsIfVersion(
  id: string,
  expected: DraftWriteVersion | null,
): Promise<boolean> {
  let removed = false;
  await db.transaction("rw", db.drafts, db.pdfBlobs, db.draftModels, async () => {
    const [model, legacy] = await Promise.all([
      db.draftModels.get(id),
      db.drafts.get(id),
    ]);
    const current = model ?? legacy;
    if (current) {
      if (!expected) return;
      if (
        current.lastTouched !== expected.lastTouched ||
        (current.revision ?? null) !== expected.revision
      ) {
        return;
      }
    }
    await Promise.all([
      db.drafts.delete(id),
      db.pdfBlobs.delete(id),
      db.draftModels.delete(id),
    ]);
    removed = true;
  });
  if (removed) {
    clearOperationLog(id);
    notifyChanged();
  }
  return removed;
}

/** Explicit user deletion: forget both recovery data and Live tombstones. */
export async function remove(id: string): Promise<void> {
  await db.transaction(
    "rw",
    db.drafts,
    db.pdfBlobs,
    db.draftModels,
    db.liveOperationReceipts,
    async () => {
      await Promise.all([
        db.drafts.delete(id),
        db.pdfBlobs.delete(id),
        db.draftModels.delete(id),
        db.liveOperationReceipts.delete(id),
      ]);
    },
  );
  clearOperationLog(id);
  notifyChanged();
}

export async function clearAll(): Promise<void> {
  await db.transaction(
    "rw",
    db.drafts,
    db.pdfBlobs,
    db.draftModels,
    db.liveOperationReceipts,
    async () => {
      await Promise.all([
        db.drafts.clear(),
        db.pdfBlobs.clear(),
        db.draftModels.clear(),
        db.liveOperationReceipts.clear(),
      ]);
    },
  );
  clearAllOperationLogs();
  notifyChanged();
}

// Runs on app startup. Drafts are retained until explicit user cleanup or
// storage pressure requires LRU eviction.
export async function cleanup(): Promise<void> {
  const [evicted] = await Promise.all([
    enforceQuota(quotaCapBytes()),
    enforceLiveOperationLedgerQuota(),
  ]);
  const activeIds = new Set((await db.draftModels.toArray()).map((row) => row.id));
  const removedLogs = pruneOperationLogs(activeIds);
  if (evicted || removedLogs) notifyChanged();
}

export const drafts = {
  get,
  put,
  remove,
  removeDraftPreservingLiveOperationReceipts,
  removeDraftPreservingLiveOperationReceiptsIfVersion,
  getLiveOperationReceipts,
  putLiveOperationReceipt,
  mergeLiveOperationReceipts,
  removeLiveOperationReceipts,
  list,
  totalBytes,
  subscribe,
  cleanup,
  clearAll,
  getEvictionNotices,
  clearEvictionNotices,
};

export const __draftsTest = {
  reset: clearAll,
  // Raw handle so tests can inject storage failures at the table level.
  db: db as Dexie,
  resetPersistentStorageRequest() {
    persistentStorageAsked = false;
  },
  setQuotaCapBytes(capBytes: number | undefined) {
    capBytesOverrideForTest = capBytes;
  },
  setLedgerCapBytes(capBytes: number | undefined) {
    ledgerCapBytesOverrideForTest = capBytes;
  },
  recordEvictions(fileNames: string[], now: number) {
    recordEvictions(fileNames, now);
  },
  async putLegacyRow(row: Draft) {
    await db.drafts.put(row);
  },
  async counts() {
    return {
      legacy: await db.drafts.count(),
      blobs: await db.pdfBlobs.count(),
      models: await db.draftModels.count(),
      receipts: await db.liveOperationReceipts.count(),
    };
  },
};

export default drafts;
