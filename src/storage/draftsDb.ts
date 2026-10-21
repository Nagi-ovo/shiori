import Dexie, { type Table } from "dexie";
import type { DocumentModel } from "../pdf/model/types";
import type { HistoryEntry } from "../editor/store/store";

// The draft database schema and its row shapes. drafts.ts holds the policy
// (autosave, eviction, Live receipts) on top of these tables.

export type Draft = {
  id: string; // sha256 of PDF bytes (hex)
  fileName: string;
  fileSize: number;
  pdfBytes: Uint8Array;
  model: DocumentModel;
  // Runtime history groups that precede `model`, oldest first (the store's
  // undoStack at save time, trimmed). Old snapshot-only drafts remain valid.
  history: HistoryEntry[];
  // Completed Live API operation ids remain valid even when their overlays
  // were undone. This prevents a later retry from restoring user-undone work.
  completedLiveOperationIds: string[];
  createdAt: number;
  lastTouched: number;
  // Opaque write token used by the clean-baseline compare-and-delete path.
  // Older rows have no token and remain compatible through `null`.
  revision?: string;
};

export type PdfBlob = {
  id: string;
  fileName: string;
  fileSize: number;
  bytes: Uint8Array;
  createdAt: number;
};

export type DraftModelRecord = {
  id: string;
  fileName: string;
  fileSize: number;
  model: DocumentModel;
  // Optional: absent on records written before history persistence. No Dexie
  // version bump needed — non-indexed properties are schemaless, and old rows
  // simply read back with `history === undefined`.
  history?: HistoryEntry[];
  completedLiveOperationIds?: string[];
  createdAt: number;
  lastTouched: number;
  revision?: string;
  pdfByteLength: number;
  modelByteLength: number;
  historyByteLength?: number;
  storageBytes: number;
};

export type LiveOperationReceiptRecord = {
  /** SHA-256 of the source PDF. This table never participates in draft restore. */
  id: string;
  operationIds: string[];
  lastTouched: number;
  storageBytes: number;
};

class DraftsDb extends Dexie {
  drafts!: Table<Draft, string>;
  pdfBlobs!: Table<PdfBlob, string>;
  draftModels!: Table<DraftModelRecord, string>;
  liveOperationReceipts!: Table<LiveOperationReceiptRecord, string>;

  constructor() {
    super("shiori");
    this.version(1).stores({
      // Primary key = id (hash); secondary index on lastTouched for LRU sweeps.
      drafts: "id, lastTouched",
    });
    this.version(2)
      .stores({
        // Keep the legacy table so a failed/partial migration never destroys
        // the only copy of user work. New code reads pdfBlobs + draftModels.
        drafts: "id, lastTouched",
        pdfBlobs: "id",
        draftModels: "id, lastTouched",
      })
      .upgrade(async (tx) => {
        const legacy = (await tx.table("drafts").toArray()) as Draft[];
        const blobs = tx.table("pdfBlobs") as Table<PdfBlob, string>;
        const models = tx.table("draftModels") as Table<DraftModelRecord, string>;
        for (const row of legacy) {
          const bytes = toUint8(row.pdfBytes);
          const pdfByteLength = bytes.byteLength;
          const modelByteLength = estimateJsonSize(row.model);
          await blobs.put({
            id: row.id,
            fileName: row.fileName,
            fileSize: row.fileSize,
            bytes,
            createdAt: row.createdAt,
          });
          await models.put({
            id: row.id,
            fileName: row.fileName,
            fileSize: row.fileSize,
            model: row.model,
            createdAt: row.createdAt,
            lastTouched: row.lastTouched,
            pdfByteLength,
            modelByteLength,
            storageBytes: estimateDraftStorage(pdfByteLength, modelByteLength),
          });
        }
      });
    this.version(3).stores({
      drafts: "id, lastTouched",
      pdfBlobs: "id",
      draftModels: "id, lastTouched",
      liveOperationReceipts: "id, lastTouched",
    });
  }
}

export const db = new DraftsDb();

export function estimateDraftStorage(pdfByteLength: number, modelByteLength: number): number {
  return pdfByteLength + modelByteLength + 512;
}

export function estimateJsonSize(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return 0;
  }
}

export function toUint8(bytes: Uint8Array | ArrayBuffer): Uint8Array {
  return bytes instanceof Uint8Array ? new Uint8Array(bytes) : new Uint8Array(bytes);
}
