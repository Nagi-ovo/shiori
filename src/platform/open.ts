import { CAPABILITIES } from "./index";
import { assertPdfWithinFileLimit } from "../pdf/openPolicy";
import {
  detectDocumentKind,
  extensionForName,
  type DocumentKind,
  type LoadedDocumentPayload,
} from "../documents/types";
import {
  assertDocumentWithinFileLimit,
  assertSafeDocxPackage,
  DocumentOpenPolicyError,
  looksLikeDocxPackage,
} from "../documents/openPolicy";

type NativePdfFileInfo = {
  name: string;
  size: number;
  path: string;
};

type NativeDocumentFileInfo = NativePdfFileInfo & {
  kind: DocumentKind;
};

export type MobileDocumentReference =
  | string
  | {
      uri: string;
      name?: string;
      size?: number;
    };

export type PlatformPdfOpenErrorCode =
  | "tooLarge"
  | "notPdf"
  | "unsupported"
  | "unavailable";

export class PlatformPdfOpenError extends Error {
  readonly code: PlatformPdfOpenErrorCode;

  constructor(code: PlatformPdfOpenErrorCode, message: string) {
    super(message);
    this.name = "PlatformPdfOpenError";
    this.code = code;
  }
}

export type LoadedPdfPayload = {
  kind?: "pdf";
  name: string;
  size: number;
  bytes: Uint8Array;
  // Absolute filesystem path, only set when we went through Tauri's native
  // dialog or the recent-docs path reopen. Web callers never see this.
  // Used as the anchor for the "recent" MRU so clicking a row can reopen
  // the same file without a second dialog.
  path?: string;
};

// Multi-select form. Every route into the app now opens N documents in one
// pass: the mobile picker, the desktop native dialog, the web file input, and
// the file-association handoff. Picking three PDFs used to open one and
// discard the rest with no message.
export type PlatformDocumentOpenFailureHandler = (
  error: Error,
  name?: string,
) => void;

export async function openDocumentsFromPlatform(
  onFailure?: PlatformDocumentOpenFailureHandler,
): Promise<LoadedDocumentPayload[]> {
  if (CAPABILITIES.mobileDocumentPicker) {
    try {
      return await openMobileDocuments(onFailure);
    } catch (err) {
      throw platformPdfOpenError(err);
    }
  }
  if (!CAPABILITIES.nativePaths) return [];
  const { commands, unwrapCommand } = await import("./ipc");
  try {
    const picked = unwrapCommand(await commands.openDocumentDialog());
    return await readSelectedDocuments(
      picked,
      readDocumentBytesForInfo,
      onFailure,
      (info) => info.name,
    );
  } catch (err) {
    throw platformPdfOpenError(err);
  }
}

/** Pick one PDF as a page source without exposing a general document dialog. */
export async function openPdfFromPlatform(
  dialogTitle: string,
): Promise<LoadedPdfPayload | null> {
  if (CAPABILITIES.mobileDocumentPicker) {
    try {
      return await openMobilePdf();
    } catch (err) {
      throw platformPdfOpenError(err);
    }
  }
  if (!CAPABILITIES.nativePaths) return null;
  const { commands, unwrapCommand } = await import("./ipc");
  try {
    const picked = unwrapCommand(await commands.openPdfDialog(dialogTitle));
    return picked ? await readPdfBytesForInfo(picked) : null;
  } catch (err) {
    throw platformPdfOpenError(err);
  }
}

// Keep selection order and peak memory predictable, but isolate failures so
// one stale path or malformed document does not discard every valid neighbour
// from the same native/mobile multi-select operation.
export async function readSelectedDocuments<T, R>(
  selected: readonly T[],
  read: (item: T) => Promise<R>,
  onFailure?: PlatformDocumentOpenFailureHandler,
  nameForItem?: (item: T) => string | undefined,
): Promise<R[]> {
  const loaded: R[] = [];
  for (const item of selected) {
    try {
      loaded.push(await read(item));
    } catch (error) {
      if (!onFailure) throw error;
      onFailure(platformPdfOpenError(error), nameForItem?.(item));
    }
  }
  return loaded;
}

export async function readDocumentBytesFromPlatformPath(
  path: string,
): Promise<LoadedDocumentPayload | null> {
  if (!CAPABILITIES.nativePaths) return null;
  const { commands, unwrapCommand } = await import("./ipc");
  try {
    const info = unwrapCommand(await commands.readDocumentInfoAtPath(path));
    return await readDocumentBytesForInfo(info);
  } catch (err) {
    throw platformPdfOpenError(err);
  }
}

export async function readMobileDocumentFromPlatformUrl(
  reference: MobileDocumentReference,
): Promise<LoadedDocumentPayload | null> {
  if (!CAPABILITIES.mobileDocumentPicker) return null;
  try {
    return await readMobileDocument(reference);
  } catch (err) {
    throw platformPdfOpenError(err);
  }
}

// Reads a platform-provided absolute path without popping a dialog.
// Returns null on web. On desktop, errors are typed so callers can separate
// stale/missing paths from beta limits and non-PDF paths.
export async function readPdfBytesFromPlatformPath(
  path: string,
): Promise<LoadedPdfPayload | null> {
  if (!CAPABILITIES.nativePaths) return null;
  const { commands, unwrapCommand } = await import("./ipc");
  try {
    const info = unwrapCommand(await commands.readPdfInfoAtPath(path));
    return await readPdfBytesForInfo(info);
  } catch (err) {
    throw platformPdfOpenError(err);
  }
}

export const readPdfAtPath = readPdfBytesFromPlatformPath;

async function readDocumentBytesForInfo(
  info: NativeDocumentFileInfo,
): Promise<LoadedDocumentPayload> {
  if (info.kind === "pdf") assertPdfWithinFileLimit(info.size);
  else assertDocumentWithinFileLimit(info.kind, info.size);
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    const raw = await invoke<ArrayBuffer | number[]>(
      "read_document_bytes_at_path",
      {
        path: info.path,
      },
    );
    const bytes = new Uint8Array(raw);
    if (info.kind === "docx") assertSafeDocxPackage(bytes);
    return {
      kind: info.kind,
      name: info.name,
      size: info.size,
      bytes,
      path: info.path,
    };
  } catch (err) {
    throw platformPdfOpenError(err);
  }
}

async function readPdfBytesForInfo(
  info: NativePdfFileInfo,
): Promise<LoadedPdfPayload> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    const raw = await invoke<ArrayBuffer | number[]>("read_pdf_bytes_at_path", {
      path: info.path,
    });
    return {
      kind: "pdf",
      name: info.name,
      size: info.size,
      bytes: new Uint8Array(raw),
      path: info.path,
    };
  } catch (err) {
    throw platformPdfOpenError(err);
  }
}

async function openMobileDocuments(
  onFailure?: PlatformDocumentOpenFailureHandler,
): Promise<LoadedDocumentPayload[]> {
  const [{ open }, { readFile }] = await Promise.all([
    import("@tauri-apps/plugin-dialog"),
    import("@tauri-apps/plugin-fs"),
  ]);
  let picked: string | string[] | null;
  try {
    picked = await open({
      multiple: true,
      directory: false,
      pickerMode: "document",
      fileAccessMode: "copy",
      filters: [
        {
          name: "Documents",
          extensions: [
            "application/pdf",
            "pdf",
            "text/markdown",
            "md",
            "markdown",
            "text/html",
            "html",
            "htm",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "docx",
          ],
        },
        {
          name: "PDF",
          extensions: ["application/pdf", "pdf"],
        },
        {
          name: "Markdown",
          extensions: ["text/markdown", "md", "markdown"],
        },
        {
          name: "HTML",
          extensions: ["text/html", "html", "htm"],
        },
        {
          name: "Word",
          extensions: [
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "docx",
          ],
        },
      ],
    });
  } catch (err) {
    if (isMobilePickerCancel(err)) return [];
    throw err;
  }
  if (!picked) return [];
  const refs = Array.isArray(picked) ? picked : [picked];
  return readSelectedDocuments(
    refs,
    (ref) => readMobileDocument(ref, readFile),
    onFailure,
    (ref) => {
      const normalized = normalizeMobileDocumentReference(ref);
      return (
        sanitizeDocumentDisplayName(normalized.name) ??
        documentNameFromPickedPath(normalized.uri)
      );
    },
  );
}

async function openMobilePdf(): Promise<LoadedPdfPayload | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  let picked: string | null;
  try {
    picked = await open({
      multiple: false,
      directory: false,
      pickerMode: "document",
      fileAccessMode: "copy",
      filters: [
        {
          name: "PDF",
          extensions: ["application/pdf", "pdf"],
        },
      ],
    });
  } catch (err) {
    if (isMobilePickerCancel(err)) return null;
    throw err;
  }
  if (!picked) return null;
  const payload = await readMobileDocument(picked);
  if (payload.kind !== "pdf") {
    throw new PlatformPdfOpenError("notPdf", "not-a-pdf");
  }
  return {
    kind: "pdf",
    name: payload.name,
    size: payload.size,
    bytes: payload.bytes,
  };
}

async function readMobileDocument(
  documentRef: MobileDocumentReference,
  readFileImpl?: (path: string) => Promise<Uint8Array>,
): Promise<LoadedDocumentPayload> {
  const readFile =
    readFileImpl ?? (await import("@tauri-apps/plugin-fs")).readFile;
  const resolvedRef = resolveMobileDocumentReference(documentRef);
  // Pre-read size guard: the kind-specific limit otherwise triggers only AFTER the
  // whole file has been read into memory (handleBytes) — on a phone that
  // can OOM before the friendly rejection fires. Fail-open: URIs that
  // cannot stat (some content:// providers) fall through to the read and
  // the existing post-read check.
  let statedSize: number | null = resolvedRef.size ?? null;
  if (statedSize === null) {
    try {
      const { stat } = await import("@tauri-apps/plugin-fs");
      const info = await stat(resolvedRef.uri);
      if (typeof info.size === "number" && Number.isFinite(info.size)) {
        statedSize = info.size;
      }
    } catch {
      // stat unsupported for this URI — the post-read limit still applies.
    }
  }
  const namedKind = detectDocumentKind(
    sanitizeDocumentDisplayName(resolvedRef.name) ??
      documentNameFromPickedPath(resolvedRef.uri),
  );
  if (statedSize !== null) {
    if (namedKind && namedKind !== "pdf") {
      assertDocumentWithinFileLimit(namedKind, statedSize);
    } else {
      assertPdfWithinFileLimit(statedSize);
    }
  }
  const bytes = await readFile(resolvedRef.uri);
  return mobileDocumentPayloadFromBytes(resolvedRef, bytes);
}

export function mobileDocumentPayloadFromBytes(
  documentRef: MobileDocumentReference,
  bytes: Uint8Array,
): LoadedDocumentPayload {
  const resolvedRef = normalizeMobileDocumentReference(documentRef);
  const name =
    sanitizeDocumentDisplayName(resolvedRef.name) ??
    documentNameFromPickedPath(resolvedRef.uri);
  const nameKind = detectDocumentKind(name);
  const hasExplicitUnsupportedExtension =
    !nameKind && extensionForName(name).length > 0;
  const kind = nameKind ?? (hasExplicitUnsupportedExtension ? null : sniffDocumentKind(bytes));
  if (!kind) throw new Error("unsupported-document");
  if (kind === "pdf") assertPdfWithinFileLimit(bytes.byteLength);
  else assertDocumentWithinFileLimit(kind, bytes.byteLength);
  if (kind === "docx") assertSafeDocxPackage(bytes);
  return {
    kind,
    name: nameKind ? name : fallbackNameForKind(kind, name),
    size: bytes.byteLength,
    bytes,
  };
}

function resolveMobileDocumentReference(
  documentRef: MobileDocumentReference,
): Exclude<MobileDocumentReference, string> {
  const normalized = normalizeMobileDocumentReference(documentRef);
  const bridge = typeof window === "undefined" ? undefined : window.ShioriAndroid;
  if (!bridge?.documentInfo) return normalized;
  try {
    const raw = bridge.documentInfo(normalized.uri);
    const parsed = JSON.parse(raw) as unknown;
    const bridgeRef = normalizeMobileDocumentReference(parsed);
    return {
      uri: normalized.uri,
      name:
        sanitizeDocumentDisplayName(normalized.name) ??
        sanitizeDocumentDisplayName(bridgeRef.name) ??
        undefined,
      size: normalized.size ?? bridgeRef.size,
    };
  } catch {
    return normalized;
  }
}

function normalizeMobileDocumentReference(
  documentRef: unknown,
): Exclude<MobileDocumentReference, string> {
  if (typeof documentRef === "string") return { uri: documentRef };
  if (documentRef && typeof documentRef === "object") {
    const value = documentRef as Record<string, unknown>;
    const uri = typeof value.uri === "string" ? value.uri : "";
    const size =
      typeof value.size === "number" && Number.isFinite(value.size)
        ? value.size
        : undefined;
    return {
      uri,
      name: sanitizeDocumentDisplayName(value.name) ?? undefined,
      size,
    };
  }
  return { uri: "" };
}

function documentNameFromPickedPath(path: string): string {
  const fallback = "document";
  const candidates = [path];
  try {
    const url = new URL(path);
    candidates.push(url.pathname);
  } catch {
    // Plain platform paths are common on desktop-like runtimes.
  }
  for (const candidate of candidates) {
    let decoded = candidate;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      // Some content providers hand back partially-escaped strings.
    }
    const name = decoded
      .split(/[\\/]/)
      .filter(Boolean)
      .pop()
      ?.split("?")[0]
      ?.split("#")[0]
      ?.trim();
    if (name) return name.includes(".") ? name : fallback;
  }
  return fallback;
}

function sanitizeDocumentDisplayName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  let trimmed = name.trim();
  if (!trimmed) return null;
  try {
    trimmed = decodeURIComponent(trimmed);
  } catch {
    // Keep the original value when Android hands back a partially-escaped name.
  }
  const basename = trimmed
    .split(/[\\/]/)
    .filter(Boolean)
    .pop()
    ?.split("?")[0]
    ?.split("#")[0]
    ?.trim();
  return basename || null;
}

function fallbackNameForKind(kind: DocumentKind, baseName = "document"): string {
  const safeBase = sanitizeFallbackBaseName(baseName) ?? "document";
  if (kind === "pdf") return `${safeBase}.pdf`;
  if (kind === "html") return `${safeBase}.html`;
  if (kind === "docx") return `${safeBase}.docx`;
  return `${safeBase}.md`;
}

function sanitizeFallbackBaseName(name: string): string | null {
  const displayName = sanitizeDocumentDisplayName(name);
  if (!displayName) return null;
  const dot = displayName.lastIndexOf(".");
  const base = dot > 0 ? displayName.slice(0, dot) : displayName;
  const normalized = base.trim();
  if (!normalized || normalized === "document") return "document";
  // Avoid using opaque Android provider IDs such as "42" or "msf:42" as a
  // fake filename when no provider display name was available.
  if (/^(?:\d+|[a-z]+:\d+)$/i.test(normalized)) return "document";
  return normalized;
}

function sniffDocumentKind(bytes: Uint8Array): DocumentKind | null {
  if (looksLikePdf(bytes)) return "pdf";
  if (looksLikeDocxPackage(bytes)) return "docx";
  if (!looksLikeUtf8Text(bytes)) return null;
  const text = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.slice(0, 8192))
    .replace(/^\uFEFF/, "")
    .trimStart();
  if (looksLikeHtml(text)) return "html";
  return "markdown";
}

function looksLikePdf(bytes: Uint8Array): boolean {
  const max = Math.min(bytes.byteLength - 5, 1024);
  for (let i = 0; i <= max; i += 1) {
    if (
      bytes[i] === 0x25 &&
      bytes[i + 1] === 0x50 &&
      bytes[i + 2] === 0x44 &&
      bytes[i + 3] === 0x46 &&
      bytes[i + 4] === 0x2d
    ) {
      return true;
    }
  }
  return false;
}

function looksLikeUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.slice(0, Math.min(bytes.byteLength, 8192)),
    );
  } catch {
    return false;
  }
  let control = 0;
  const sampleLength = Math.min(bytes.byteLength, 8192);
  for (let i = 0; i < sampleLength; i += 1) {
    const value = bytes[i]!;
    const allowedControl =
      value === 0x09 || value === 0x0a || value === 0x0d || value === 0x0c;
    if (value < 0x20 && !allowedControl) control += 1;
  }
  return control / sampleLength < 0.02;
}

function looksLikeHtml(text: string): boolean {
  const head = text.slice(0, 2048).toLowerCase();
  return (
    head.startsWith("<!doctype html") ||
    head.startsWith("<html") ||
    head.startsWith("<head") ||
    head.startsWith("<body") ||
    /^<(article|aside|div|main|section|p|h[1-6]|table|ul|ol|pre|blockquote)\b/.test(
      head,
    )
  );
}

function isMobilePickerCancel(err: unknown): boolean {
  const message = String(err instanceof Error ? err.message : err);
  return message === "File picker cancelled";
}

export function isPlatformPdfOpenError(
  err: unknown,
): err is PlatformPdfOpenError {
  return err instanceof PlatformPdfOpenError;
}

function platformPdfOpenError(err: unknown): Error {
  // Non-PDF formats have their own size/package policy and localized UI.
  // Preserve its typed error across the platform boundary instead of
  // flattening it into the legacy PDF-oriented `unavailable` bucket.
  if (err instanceof DocumentOpenPolicyError) return err;
  const message = String(err instanceof Error ? err.message : err);
  if (message === "too-large") {
    return new PlatformPdfOpenError("tooLarge", message);
  }
  if (message === "not-a-pdf") {
    return new PlatformPdfOpenError("notPdf", message);
  }
  if (message === "unsupported-document") {
    return new PlatformPdfOpenError("unsupported", message);
  }
  return new PlatformPdfOpenError("unavailable", message);
}
