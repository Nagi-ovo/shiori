import Dexie, { type Table } from "dexie";
import type {
  DocumentModel,
  Overlay,
  PageModel,
  PdfPoint,
  PdfRect,
} from "../pdf/model/types";
import type {
  HistoryEntry,
  OverlayBatchHistoryEntry,
} from "../editor/store/store";
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

const HISTORY_ID_MAX_CHARS = 256;
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

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

type PdfBlob = {
  id: string;
  fileName: string;
  fileSize: number;
  bytes: Uint8Array;
  createdAt: number;
};

type DraftModelRecord = {
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

type LiveOperationReceiptRecord = {
  /** SHA-256 of the source PDF. This table never participates in draft restore. */
  id: string;
  operationIds: string[];
  lastTouched: number;
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

const db = new DraftsDb();
// A plain listener set rather than EventTarget/Event: the payload is empty
// (subscribers just re-read), and a global Event dispatched on a global
// EventTarget breaks in mixed test realms where one global was swapped for a
// DOM shim but not the other. Mirrors the toast bus.
const changeListeners = new Set<() => void>();

export function subscribe(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

function notifyChanged(): void {
  for (const listener of changeListeners) listener();
}

function estimateDraftStorage(pdfByteLength: number, modelByteLength: number): number {
  return pdfByteLength + modelByteLength + 512;
}

function estimateJsonSize(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return 0;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value >= 0;
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}

function isBoundedId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= HISTORY_ID_MAX_CHARS
  );
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR_RE.test(value);
}

function isPdfPoint(value: unknown): value is PdfPoint {
  return isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y);
}

function isPdfRect(value: unknown): value is PdfRect {
  return (
    isRecord(value) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.w) &&
    value.w > 0 &&
    isFiniteNumber(value.h) &&
    value.h > 0
  );
}

function isPageModel(value: unknown): value is PageModel {
  if (!isRecord(value)) return false;
  return (
    isBoundedId(value.id) &&
    isSafeInteger(value.sourceIndex) &&
    (value.rotation === 0 ||
      value.rotation === 90 ||
      value.rotation === 180 ||
      value.rotation === 270) &&
    isOptionalFiniteNumber(value.originXPt) &&
    isOptionalFiniteNumber(value.originYPt) &&
    isFiniteNumber(value.widthPt) &&
    value.widthPt > 0 &&
    isFiniteNumber(value.heightPt) &&
    value.heightPt > 0 &&
    (value.blank === undefined || typeof value.blank === "boolean")
  );
}

function hasValidOverlayCommon(value: Record<string, unknown>): boolean {
  return (
    isBoundedId(value.id) &&
    isBoundedId(value.pageId) &&
    (value.locked === undefined || typeof value.locked === "boolean") &&
    hasValidSourceProvenance(value)
  );
}

// Optional review provenance copied from an imported annotation. Absent on
// every overlay Shiori authored, and absent from drafts written before the
// fields existed — so each check has to tolerate undefined.
function hasValidSourceProvenance(value: Record<string, unknown>): boolean {
  return (
    (value.sourceAuthor === undefined ||
      (typeof value.sourceAuthor === "string" &&
        value.sourceAuthor.length <= 512)) &&
    isOptionalFiniteNumber(value.sourceCreatedAt) &&
    isOptionalFiniteNumber(value.sourceModifiedAt) &&
    (value.sourceInReplyToId === undefined ||
      isBoundedId(value.sourceInReplyToId)) &&
    (value.sourceReplyType === undefined ||
      value.sourceReplyType === "R" ||
      value.sourceReplyType === "Group")
  );
}

function hasValidAngle(value: Record<string, unknown>): boolean {
  return isOptionalFiniteNumber(value.angle);
}

function hasValidTextStyle(value: Record<string, unknown>): boolean {
  return (
    typeof value.text === "string" &&
    isFiniteNumber(value.fontSize) &&
    value.fontSize > 0 &&
    isHexColor(value.color) &&
    typeof value.bold === "boolean" &&
    (value.italic === undefined || typeof value.italic === "boolean") &&
    (value.align === "left" ||
      value.align === "center" ||
      value.align === "right") &&
    (value.fontFamily === "sans" ||
      value.fontFamily === "serif" ||
      value.fontFamily === "mono" ||
      value.fontFamily === "notoSansSc" ||
      value.fontFamily === "notoSansJp")
  );
}

function isOverlay(value: unknown): value is Overlay {
  if (!isRecord(value) || !hasValidOverlayCommon(value)) return false;
  if (
    value.type === "highlight" ||
    value.type === "underline" ||
    value.type === "strikethrough"
  ) {
    return (
      Array.isArray(value.rects) &&
      value.rects.every(isPdfRect) &&
      isHexColor(value.color) &&
      isFiniteNumber(value.opacity) &&
      value.opacity >= 0 &&
      value.opacity <= 1
    );
  }
  if (value.type === "ink") {
    return (
      Array.isArray(value.paths) &&
      value.paths.every(
        (path) => Array.isArray(path) && path.every(isPdfPoint),
      ) &&
      isHexColor(value.color) &&
      isFiniteNumber(value.width) &&
      value.width > 0 &&
      (value.source === undefined || value.source === "signature")
    );
  }
  if (value.type === "image") {
    return (
      isPdfRect(value.rect) &&
      (value.mimeType === "image/png" || value.mimeType === "image/jpeg") &&
      typeof value.dataUrl === "string" &&
      value.dataUrl.startsWith(`data:${value.mimeType};base64,`) &&
      (value.source === undefined || value.source === "signature") &&
      hasValidAngle(value)
    );
  }
  if (value.type === "stamp") {
    return (
      (value.kind === "check" || value.kind === "cross") &&
      isPdfRect(value.rect) &&
      isHexColor(value.color) &&
      isFiniteNumber(value.strokeWidth) &&
      value.strokeWidth > 0 &&
      hasValidAngle(value)
    );
  }
  if (value.type === "rect") {
    return (
      isPdfRect(value.rect) &&
      isHexColor(value.color) &&
      isFiniteNumber(value.strokeWidth) &&
      value.strokeWidth > 0 &&
      (value.fill === null || isHexColor(value.fill)) &&
      hasValidAngle(value)
    );
  }
  if (value.type === "note") {
    return (
      isPdfRect(value.rect) &&
      typeof value.text === "string" &&
      isHexColor(value.color) &&
      (value.createdAt === undefined ||
        isNonNegativeSafeInteger(value.createdAt)) &&
      (value.updatedAt === undefined ||
        isNonNegativeSafeInteger(value.updatedAt)) &&
      hasValidAngle(value)
    );
  }
  if (value.type === "text") {
    return isPdfRect(value.rect) && hasValidTextStyle(value) && hasValidAngle(value);
  }
  if (value.type === "callout") {
    return (
      isPdfRect(value.rect) &&
      Array.isArray(value.targetRects) &&
      value.targetRects.length > 0 &&
      value.targetRects.every(isPdfRect) &&
      (value.leader === undefined ||
        (Array.isArray(value.leader) &&
          (value.leader.length === 2 || value.leader.length === 3) &&
          value.leader.every(isPdfPoint))) &&
      (value.leaderKind === undefined ||
        value.leaderKind === "polyline" ||
        value.leaderKind === "quadratic") &&
      hasValidTextStyle(value)
    );
  }
  if (value.type === "contentText") {
    return (
      isPdfRect(value.rect) &&
      Array.isArray(value.coverRects) &&
      value.coverRects.every(isPdfRect) &&
      (value.sourceBaselinesPt === undefined ||
        (Array.isArray(value.sourceBaselinesPt) &&
          value.sourceBaselinesPt.every(isFiniteNumber))) &&
      isOptionalFiniteNumber(value.firstLineIndentPt) &&
      typeof value.originalText === "string" &&
      hasValidTextStyle(value) &&
      (value.renderedFont === undefined || typeof value.renderedFont === "string") &&
      (value.sourceFontName === undefined ||
        typeof value.sourceFontName === "string") &&
      isHexColor(value.backgroundColor) &&
      hasValidAngle(value)
    );
  }
  return false;
}

function hasUniqueIds(values: ReadonlyArray<{ id: string }>): boolean {
  const ids = new Set(values.map((value) => value.id));
  return ids.size === values.length;
}

function isDocumentModel(value: unknown): value is DocumentModel {
  if (!isRecord(value) || "kind" in value) return false;
  if (!Array.isArray(value.pages) || !value.pages.every(isPageModel)) return false;
  if (!hasUniqueIds(value.pages)) return false;
  if (!Array.isArray(value.overlays) || !value.overlays.every(isOverlay)) {
    return false;
  }
  if (!hasUniqueIds(value.overlays)) return false;
  const pageIds = new Set(value.pages.map((page) => page.id));
  return value.overlays.every((overlay) => pageIds.has(overlay.pageId));
}

const LIVE_BATCH_OVERLAY_TYPES = new Set([
  "highlight",
  "underline",
  "strikethrough",
  "ink",
  "stamp",
  "rect",
  "note",
  "callout",
  "text",
]);

function isOverlayBatchHistoryEntry(
  value: unknown,
): value is OverlayBatchHistoryEntry {
  if (!isRecord(value) || value.kind !== "overlay-batch") return false;
  if (!isSha256Hex(value.operationId)) {
    return false;
  }
  if (!Array.isArray(value.overlays) || value.overlays.length === 0) return false;
  if (!value.overlays.every(isOverlay) || !hasUniqueIds(value.overlays)) return false;
  if (
    !isSafeInteger(value.cursor) ||
    value.cursor <= 0 ||
    value.cursor > value.overlays.length
  ) {
    return false;
  }
  return value.overlays.every((overlay, index) => {
    if (!LIVE_BATCH_OVERLAY_TYPES.has(overlay.type)) return false;
    return overlay.id === `live-${overlay.type}-${value.operationId}-${index + 1}`;
  });
}

// Persisted history round-trips through IndexedDB and may come from older or
// corrupted records. Discriminate the tagged batch shape first: a malicious
// object must not masquerade as a DocumentModel merely by adding pages[].
function sanitizeHistory(value: unknown): HistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is HistoryEntry => {
    if (!isRecord(entry)) return false;
    return entry.kind === "overlay-batch"
      ? isOverlayBatchHistoryEntry(entry)
      : isDocumentModel(entry);
  });
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

function toUint8(bytes: Uint8Array | ArrayBuffer): Uint8Array {
  return bytes instanceof Uint8Array ? new Uint8Array(bytes) : new Uint8Array(bytes);
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

// Bytes still held by v1 rows the v2 upgrade deliberately left in place as a
// safety copy. They are real occupied space that the app's own cap never saw,
// so the store could exceed CAP_BYTES by the size of everything migrated and
// hit the browser's quota earlier than the app expected.
async function legacyDraftBytesById(): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  try {
    for (const row of await db.drafts.toArray()) {
      const bytes = row.pdfBytes as { byteLength?: number } | undefined;
      const size = typeof bytes?.byteLength === "number" ? bytes.byteLength : 0;
      if (size > 0) sizes.set(row.id, size);
    }
  } catch {
    // The legacy table is absent on installs that never ran schema v1.
  }
  return sizes;
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
    await evictAfterQuotaFailure(incoming.id, storageBytes);
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
    await enforceQuota(incoming.id);
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
    enforceQuota(),
    enforceLiveOperationLedgerQuota(),
  ]);
  const activeIds = new Set((await db.draftModels.toArray()).map((row) => row.id));
  const removedLogs = pruneOperationLogs(activeIds);
  if (evicted || removedLogs) notifyChanged();
}

// Eviction target for the retry after IndexedDB has ALREADY rejected a write
// with QuotaExceededError.
//
// The old target was `0.8 * CAP_BYTES - incomingBytes`, and CAP_BYTES is a
// hardcoded 1 GB. Whenever the origin's real quota was smaller than that —
// a nearly full disk, or WebKit/WKWebView's per-origin ceiling — the store was
// already under the app cap, so enforceQuota returned immediately having freed
// nothing, the retry hit the same wall, and autosave failed permanently with a
// single toast and no way to recover.
//
// Three bounds, whichever is tightest:
//   - the app's own cap, unchanged for the normal case
//   - the browser's reported quota, which is the limit actually being hit
//   - a floor that always frees a fifth of what is stored, so a retry after a
//     real failure can never be a no-op even when both numbers look fine
//     (the browser's estimate is approximate, and other databases on this
//     origin — shiori-workspace — consume the same budget without appearing
//     in these rows)
async function evictAfterQuotaFailure(
  protectId: string,
  incomingBytes: number,
): Promise<boolean> {
  const rows = await db.draftModels.toArray();
  const stored = rows.reduce((sum, row) => sum + row.storageBytes, 0);

  const byAppCap = Math.floor(quotaCapBytes() * 0.8) - incomingBytes;

  // Read inline rather than through platform/metrics: that module pulls in the
  // platform layer, which imports this one, and the cycle breaks module init.
  let byBrowserQuota = Number.POSITIVE_INFINITY;
  try {
    const quota = (await navigator?.storage?.estimate?.())?.quota;
    if (typeof quota === "number" && quota > 0) {
      byBrowserQuota = Math.floor(quota * 0.8) - incomingBytes;
    }
  } catch {
    // No estimate available (older engines, private mode): the progress floor
    // below still guarantees the retry makes room.
  }

  const byProgress = Math.floor(stored * 0.8);
  const target = Math.max(
    0,
    Math.min(byAppCap, byBrowserQuota, byProgress),
  );
  return enforceQuota(protectId, target);
}

// Evict oldest drafts until total bytes <= CAP_BYTES. If `protectId` is
// provided, that draft is kept even if it would otherwise be evicted
// (but may still trigger eviction of others).
async function enforceQuota(
  protectId?: string,
  targetBytes: number = quotaCapBytes(),
): Promise<boolean> {
  const rows = await db.draftModels.orderBy("lastTouched").toArray();
  // Legacy v1 rows are counted here for the same reason totalBytes counts
  // them: they occupy the origin's quota even though only the v2 tables
  // describe the drafts. Eviction deletes both, so both come off the total.
  const legacyBytesById = await legacyDraftBytesById();
  let total =
    rows.reduce((sum, r) => sum + r.storageBytes, 0) +
    [...legacyBytesById.values()].reduce((sum, bytes) => sum + bytes, 0);
  if (total <= targetBytes) return false;
  const evictedNames: string[] = [];
  for (const r of rows) {
    if (total <= targetBytes) break;
    if (r.id === protectId) continue;
    // Delete the legacy v1 row too: the v2 upgrade keeps it as a safety copy
    // and get() falls back to it, so dropping only the v2 tables would let an
    // evicted draft be resurrected (and make the eviction notice a lie).
    await db.transaction("rw", db.drafts, db.pdfBlobs, db.draftModels, async () => {
      await Promise.all([
        db.drafts.delete(r.id),
        db.pdfBlobs.delete(r.id),
        db.draftModels.delete(r.id),
      ]);
    });
    clearOperationLog(r.id);
    total -= r.storageBytes + (legacyBytesById.get(r.id) ?? 0);
    evictedNames.push(r.fileName);
  }
  // Surface what was dropped: silently deleting saved work is a trust killer
  // for a local-first tool. The notice waits in localStorage until the user
  // next opens Settings → Storage.
  if (evictedNames.length > 0) recordEvictions(evictedNames, Date.now());
  // If still over (single protected draft bigger than cap), we accept it:
  // keeping the active user's work beats silently dropping the only draft.
  return evictedNames.length > 0;
}

// Non-blocking record of drafts dropped by LRU eviction, kept in localStorage
// so Settings → Storage can tell the user what was cleared. Separate from the
// drafts themselves (IndexedDB); best-effort and never blocks eviction.
export type EvictionNotice = { fileName: string; evictedAt: number };

const EVICTIONS_KEY = "shiori:draft-evictions:v1";
const MAX_EVICTION_NOTICES = 20;

function evictionStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readEvictionNotices(storage: Storage): EvictionNotice[] {
  try {
    const raw = storage.getItem(EVICTIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (n): n is EvictionNotice =>
        !!n &&
        typeof (n as EvictionNotice).fileName === "string" &&
        typeof (n as EvictionNotice).evictedAt === "number",
    );
  } catch {
    return [];
  }
}

function recordEvictions(fileNames: string[], now: number): void {
  const storage = evictionStorage();
  if (!storage) return;
  try {
    const next = [
      ...readEvictionNotices(storage),
      ...fileNames.map((fileName) => ({ fileName, evictedAt: now })),
    ].slice(-MAX_EVICTION_NOTICES);
    storage.setItem(EVICTIONS_KEY, JSON.stringify(next));
  } catch {
    // Best-effort: the notice is a courtesy, never block eviction on it.
  }
}

export function getEvictionNotices(): EvictionNotice[] {
  const storage = evictionStorage();
  return storage ? readEvictionNotices(storage) : [];
}

export function clearEvictionNotices(): void {
  const storage = evictionStorage();
  if (!storage) return;
  try {
    storage.removeItem(EVICTIONS_KEY);
  } catch {
    // ignore
  }
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
