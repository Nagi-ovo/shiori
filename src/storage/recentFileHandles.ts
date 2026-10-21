import Dexie, { type Table } from "dexie";
import {
  detectDocumentKind,
  DOCUMENT_PICKER_ACCEPT,
  type DocumentKind,
} from "../documents/types";
import {
  assertDocumentWithinFileLimit,
  assertSafeDocxPackage,
  DocumentOpenPolicyError,
} from "../documents/openPolicy";
import { assertPdfWithinFileLimit, MAX_PDF_BYTES } from "../pdf/openPolicy";

const DB_NAME = "shiori-recent-file-handles";
const MAX_HANDLES = 24;

type WebFilePermissionState = "granted" | "denied" | "prompt";
type WebFilePermissionMode = "read" | "readwrite";
type WebFilePermissionDescriptor = { mode: WebFilePermissionMode };
type WebWritableFileStream = {
  write: (data: string | BufferSource | Blob) => Promise<void>;
  close: () => Promise<void>;
  abort?: (reason?: unknown) => Promise<void>;
};
export type WebFileHandle = {
  name: string;
  getFile: () => Promise<File>;
  // Present only in browsers with the writable half of the File System Access
  // API (Chromium today; Safari and Firefox ship the read half only).
  createWritable?: (options?: {
    keepExistingData?: boolean;
  }) => Promise<WebWritableFileStream>;
  isSameEntry?: (other: WebFileHandle) => Promise<boolean>;
  queryPermission?: (
    descriptor: WebFilePermissionDescriptor,
  ) => Promise<WebFilePermissionState>;
  requestPermission?: (
    descriptor: WebFilePermissionDescriptor,
  ) => Promise<WebFilePermissionState>;
};

type WindowWithFileSystemPicker = Window & {
  showOpenFilePicker?: WebFilePicker;
};

type WebFilePicker = (options?: {
  multiple?: boolean;
  excludeAcceptAllOption?: boolean;
  types?: WebFilePickerType[];
}) => Promise<WebFileHandle[]>;

type WebFilePickerType = {
  description?: string;
  accept: Record<string, string[]>;
};

type RecentFileHandleRecord = {
  id: string;
  name: string;
  handle: WebFileHandle;
  savedAt: number;
};

export type WebFileHandlePdfPayload = {
  name: string;
  size: number;
  bytes: Uint8Array;
  webFileHandleId?: string;
};

export type WebFileHandleDocumentPayload = WebFileHandlePdfPayload;

export type WebFileHandleOpenErrorCode =
  | "handleMissing"
  | "permissionDenied"
  | "fileUnavailable"
  | "notPdf";

export class WebFileHandleOpenError extends Error {
  readonly code: WebFileHandleOpenErrorCode;

  constructor(
    code: WebFileHandleOpenErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "WebFileHandleOpenError";
    this.code = code;
  }
}

export function isWebFileHandleOpenError(
  err: unknown,
): err is WebFileHandleOpenError {
  return err instanceof WebFileHandleOpenError;
}

class RecentFileHandlesDb extends Dexie {
  handles!: Table<RecentFileHandleRecord, string>;

  constructor() {
    super(DB_NAME);
    this.version(1).stores({
      handles: "id, savedAt",
    });
  }
}

const db = new RecentFileHandlesDb();

export function canUseWebFileHandles(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as WindowWithFileSystemPicker).showOpenFilePicker ===
      "function" &&
    typeof indexedDB !== "undefined"
  );
}

export async function openPdfWithWebFileHandlePicker(
  options: { persistHandle?: boolean } = {},
): Promise<WebFileHandlePdfPayload | null> {
  const picker = (window as WindowWithFileSystemPicker).showOpenFilePicker;
  if (!picker) return null;
  return openPdfWithWebFileHandlePickerUsing(picker, options);
}

async function openPdfWithWebFileHandlePickerUsing(
  picker: WebFilePicker,
  options: { persistHandle?: boolean } = {},
): Promise<WebFileHandlePdfPayload | null> {
  return openDocumentWithWebFileHandlePickerUsing(
    picker,
    [
      {
        description: "PDF",
        accept: { "application/pdf": [".pdf"] },
      },
    ],
    {
      ...options,
      requiredKind: "pdf",
      // A PDF-only command must not offer “All files”. Chromium otherwise
      // lets a user pick an arbitrary document even though the picker has a
      // PDF MIME filter.
      excludeAcceptAllOption: true,
    },
  );
}

type WebFileHandlePickOptions = {
  persistHandle?: boolean;
  requiredKind?: DocumentKind;
  excludeAcceptAllOption?: boolean;
};

const DOCUMENT_PICKER_TYPES: WebFilePickerType[] = [
  {
    description: "Documents",
    accept: DOCUMENT_PICKER_ACCEPT as Record<string, string[]>,
  },
];

export async function openDocumentWithWebFileHandlePicker(
  types: WebFilePickerType[] = DOCUMENT_PICKER_TYPES,
  options: WebFileHandlePickOptions = {},
): Promise<WebFileHandleDocumentPayload | null> {
  const picker = (window as WindowWithFileSystemPicker).showOpenFilePicker;
  if (!picker) return null;
  return openDocumentWithWebFileHandlePickerUsing(picker, types, options);
}

async function openDocumentWithWebFileHandlePickerUsing(
  picker: WebFilePicker,
  types: WebFilePickerType[],
  options: WebFileHandlePickOptions,
): Promise<WebFileHandleDocumentPayload | null> {
  const handles = await pickWebFileHandles(picker, types, options, false);
  const handle = handles[0];
  if (!handle) return null;
  return readAndRememberPickedHandle(handle, options);
}

/**
 * The Open command on Chromium: a multi-select, like the hidden file input,
 * the desktop dialog and the mobile picker. Each file is read and remembered
 * on its own; one that cannot be read is reported and the rest still open.
 */
export async function openDocumentsWithWebFileHandlePicker(
  onError: (error: unknown, name?: string) => void,
): Promise<WebFileHandleDocumentPayload[]> {
  const picker = (window as WindowWithFileSystemPicker).showOpenFilePicker;
  if (!picker) return [];
  return openDocumentsWithWebFileHandlePickerUsing(picker, onError);
}

async function openDocumentsWithWebFileHandlePickerUsing(
  picker: WebFilePicker,
  onError: (error: unknown, name?: string) => void,
): Promise<WebFileHandleDocumentPayload[]> {
  const handles = await pickWebFileHandles(picker, DOCUMENT_PICKER_TYPES, {}, true);
  const payloads: WebFileHandleDocumentPayload[] = [];
  for (const handle of handles) {
    try {
      payloads.push(await readAndRememberPickedHandle(handle, {}));
    } catch (err) {
      onError(err, handle.name);
    }
  }
  return payloads;
}

async function pickWebFileHandles(
  picker: WebFilePicker,
  types: WebFilePickerType[],
  options: WebFileHandlePickOptions,
  multiple: boolean,
): Promise<WebFileHandle[]> {
  try {
    return await picker({
      multiple,
      excludeAcceptAllOption: options.excludeAcceptAllOption ?? false,
      types,
    });
  } catch (err) {
    if (isPickerAbort(err)) return [];
    throw err;
  }
}

async function readAndRememberPickedHandle(
  handle: WebFileHandle,
  options: WebFileHandlePickOptions,
): Promise<WebFileHandleDocumentPayload> {
  // Validate and read before persisting the capability. A cancelled, invalid,
  // or unreadable one-off source must never consume one of the recent-handle
  // slots or leave a durable browser permission behind.
  const payload = await readPickedWebFileHandle(
    handle,
    undefined,
    options.requiredKind,
  );
  // One-off sources such as “Insert pages from PDF” should not leave a
  // durable browser capability in IndexedDB. Normal document opening keeps
  // the default so recents can reopen the same file without another picker.
  const webFileHandleId =
    options.persistHandle === false
      ? undefined
      : await rememberWebFileHandle(handle).catch((err) => {
          console.warn("web file handle persistence failed", err);
          return undefined;
        });
  return { ...payload, webFileHandleId };
}

export async function readPdfFromWebFileHandle(
  webFileHandleId: string,
): Promise<WebFileHandlePdfPayload> {
  return readDocumentFromWebFileHandle(webFileHandleId);
}

export async function readDocumentFromWebFileHandle(
  webFileHandleId: string,
): Promise<WebFileHandleDocumentPayload> {
  const record = await db.handles.get(webFileHandleId);
  if (!record) {
    throw new WebFileHandleOpenError(
      "handleMissing",
      "Saved browser file handle is missing",
    );
  }
  const payload = await readWebFileHandle(record.handle, webFileHandleId);
  await touchWebFileHandle(webFileHandleId);
  return payload;
}

/**
 * Writes edited text back through the handle the document was opened from.
 *
 * Only Chromium-family browsers implement the writable half of the File System
 * Access API, so `createWritable` being absent is an ordinary outcome, not a
 * failure — it reports `"unsupported"` and the caller falls back to a download.
 * Write permission is a *separate* grant from the read permission taken at
 * open, and requesting it needs a user gesture: call this straight out of the
 * click / keydown handler, never after an await that yields to a timer.
 */
export type WebFileHandleWriteResult =
  | "written"
  | "unsupported"
  | "permissionDenied"
  | "handleMissing"
  | "changed"
  // `unchanged` could not read the file, so nothing was written.
  | "unverified";

export async function writeTextToWebFileHandle(
  webFileHandleId: string,
  text: string,
  unchanged?: (current: Uint8Array) => Promise<boolean>,
): Promise<WebFileHandleWriteResult> {
  const record = await db.handles.get(webFileHandleId);
  if (!record) return "handleMissing";
  const result = await writeTextToHandle(record.handle, text, unchanged);
  // Saving counts as use. Eviction is LRU over savedAt, and only the READ
  // path refreshed it — so a tab left open for a long editing session, saved
  // repeatedly but never re-read, aged out and had its handle deleted from
  // under it. The next ⌘S then failed with "the browser forgot the saved
  // file permission" on a document the reader had been working in all along.
  if (result === "written") await touchWebFileHandle(webFileHandleId);
  return result;
}

async function writeTextToHandle(
  handle: WebFileHandle,
  text: string,
  unchanged?: (current: Uint8Array) => Promise<boolean>,
): Promise<WebFileHandleWriteResult> {
  if (typeof handle.createWritable !== "function") return "unsupported";
  if (!(await ensurePermission(handle, "readwrite"))) return "permissionDenied";
  // Checked after the grant: the request needs the click's activation, which
  // reading the file first could outlive. A check that cannot read the file
  // vouches for nothing; only a deleted file is left to the write to report.
  if (unchanged) {
    let current: Uint8Array | null = null;
    try {
      current = new Uint8Array(await (await handle.getFile()).arrayBuffer());
    } catch (err) {
      if ((err as { name?: unknown } | null)?.name !== "NotFoundError") return "unverified";
    }
    if (current && !(await unchanged(current))) return "changed";
  }
  // Not keepExistingData: the tab holds the whole document, so the write is a
  // full replace. Keeping the old bytes would leave a tail behind whenever the
  // edited text is shorter than what was on disk.
  const writable = await handle.createWritable({ keepExistingData: false });
  try {
    await writable.write(text);
  } catch (err) {
    // Abort discards the staged file so a half-written document never lands
    // on top of the user's original.
    await writable.abort?.(err).catch(() => {});
    throw err;
  }
  await writable.close();
  return "written";
}

export async function forgetWebFileHandle(
  webFileHandleId: string | undefined,
): Promise<void> {
  if (!webFileHandleId) return;
  try {
    await db.handles.delete(webFileHandleId);
  } catch {
    // Best-effort cleanup only; the localStorage recent entry is already gone.
  }
}

async function rememberWebFileHandle(handle: WebFileHandle): Promise<string> {
  const now = Date.now();
  const existing = await findExistingHandle(handle);
  if (existing) {
    await db.handles.update(existing.id, {
      name: handle.name,
      handle,
      savedAt: now,
    });
    return existing.id;
  }

  const id = makeHandleId();
  await db.handles.put({
    id,
    name: handle.name,
    handle,
    savedAt: now,
  });
  await pruneOldHandles();
  return id;
}

async function findExistingHandle(
  handle: WebFileHandle,
): Promise<RecentFileHandleRecord | null> {
  if (!handle.isSameEntry) return null;
  try {
    const records = await db.handles.toArray();
    for (const record of records) {
      if (await record.handle.isSameEntry?.(handle)) return record;
    }
  } catch {
    return null;
  }
  return null;
}

async function pruneOldHandles(): Promise<void> {
  const stale = await db.handles
    .orderBy("savedAt")
    .reverse()
    .offset(MAX_HANDLES)
    .primaryKeys();
  if (stale.length > 0) await db.handles.bulkDelete(stale);
}

async function touchWebFileHandle(id: string): Promise<void> {
  try {
    await db.handles.update(id, { savedAt: Date.now() });
  } catch (error) {
    // A successful file read remains successful if recency bookkeeping fails.
    console.warn("web file handle recency update failed", error);
  }
}

async function readWebFileHandle(
  handle: WebFileHandle,
  webFileHandleId: string | undefined,
): Promise<WebFileHandlePdfPayload> {
  const permission = await ensureReadPermission(handle);
  if (!permission) {
    throw new WebFileHandleOpenError(
      "permissionDenied",
      "Browser file access was denied",
    );
  }
  try {
    return await readPickedWebFileHandle(handle, webFileHandleId);
  } catch (err) {
    if (err instanceof DocumentOpenPolicyError) throw err;
    throw new WebFileHandleOpenError(
      "fileUnavailable",
      "Saved browser file handle could not be read",
      { cause: err },
    );
  }
}

export const __recentFileHandlesTest = {
  openPdfWithWebFileHandlePickerUsing,
  openDocumentsWithWebFileHandlePickerUsing,
  readWebFileHandle,
  writeTextToHandle,
  touchWebFileHandle,
  db,
};

async function readPickedWebFileHandle(
  handle: WebFileHandle,
  webFileHandleId: string | undefined,
  requiredKind?: DocumentKind,
): Promise<WebFileHandlePdfPayload> {
  const file = await handle.getFile();
  const kind = detectDocumentKind(file.name);
  if (requiredKind === "pdf" && kind !== "pdf") {
    throw new WebFileHandleOpenError(
      "notPdf",
      "The selected file is not a PDF",
    );
  }
  if (kind === "pdf") assertPdfWithinFileLimit(file.size);
  else if (kind) assertDocumentWithinFileLimit(kind, file.size);
  else if (file.size > MAX_PDF_BYTES) assertPdfWithinFileLimit(file.size);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (kind === "docx") assertSafeDocxPackage(bytes);
  return {
    name: file.name,
    size: file.size,
    bytes,
    webFileHandleId,
  };
}

async function ensureReadPermission(handle: WebFileHandle): Promise<boolean> {
  return ensurePermission(handle, "read");
}

async function ensurePermission(
  handle: WebFileHandle,
  mode: WebFilePermissionMode,
): Promise<boolean> {
  const descriptor: WebFilePermissionDescriptor = { mode };
  if (handle.queryPermission) {
    const state = await handle.queryPermission(descriptor);
    if (state === "granted") return true;
  }
  if (!handle.requestPermission) return true;
  return (await handle.requestPermission(descriptor)) === "granted";
}

function isPickerAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function makeHandleId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
