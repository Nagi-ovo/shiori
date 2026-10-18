import type { DocumentKind } from "./types";

export const MAX_TEXT_DOCUMENT_BYTES = 25 * 1024 * 1024;
export const MAX_DOCX_BYTES = 50 * 1024 * 1024;
export const MAX_DOCX_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;
export const MAX_DOCX_ENTRIES = 4_096;

export type DocumentOpenPolicyErrorKind =
  | "tooLarge"
  | "invalidDocx"
  | "docxTooComplex";

export class DocumentOpenPolicyError extends Error {
  readonly kind: DocumentOpenPolicyErrorKind;
  readonly documentKind: Exclude<DocumentKind, "pdf">;

  constructor(
    kind: DocumentOpenPolicyErrorKind,
    documentKind: Exclude<DocumentKind, "pdf">,
    message: string,
  ) {
    super(message);
    this.name = "DocumentOpenPolicyError";
    this.kind = kind;
    this.documentKind = documentKind;
  }
}

export function maxDocumentBytes(kind: DocumentKind): number | null {
  if (kind === "markdown" || kind === "html") {
    return MAX_TEXT_DOCUMENT_BYTES;
  }
  if (kind === "docx") return MAX_DOCX_BYTES;
  return null;
}

export function assertDocumentWithinFileLimit(
  kind: Exclude<DocumentKind, "pdf">,
  size: number,
): void {
  const max = maxDocumentBytes(kind);
  if (
    max !== null &&
    (!Number.isFinite(size) || size < 0 || size > max)
  ) {
    throw new DocumentOpenPolicyError(
      "tooLarge",
      kind,
      `${kind} is ${size} bytes (limit ${max})`,
    );
  }
}

/**
 * Reads ZIP central-directory metadata without inflating document parts.
 * This closes the gap between the small compressed `.docx` on disk and the
 * much larger allocation a synchronous unzip can request on the UI thread.
 */
export function assertSafeDocxPackage(bytes: Uint8Array): void {
  assertDocumentWithinFileLimit("docx", bytes.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0 || eocd + 22 > view.byteLength) invalidDocx("missing EOCD");

  const disk = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    invalidDocx("multi-disk or ZIP64 package");
  }
  if (entryCount > MAX_DOCX_ENTRIES) {
    tooComplex(`DOCX contains ${entryCount} entries`);
  }
  if (
    centralOffset > view.byteLength ||
    centralSize > view.byteLength - centralOffset ||
    centralOffset + centralSize > eocd
  ) {
    invalidDocx("central directory is outside the package");
  }

  let offset = centralOffset;
  let totalUncompressed = 0;
  let hasContentTypes = false;
  let hasMainDocument = false;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  for (let index = 0; index < entryCount; index += 1) {
    if (
      offset + 46 > view.byteLength ||
      view.getUint32(offset, true) !== 0x02014b50
    ) {
      invalidDocx(`invalid central entry ${index}`);
    }
    const flags = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const diskStart = view.getUint16(offset + 34, true);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > view.byteLength || diskStart !== 0 || (flags & 0x1) !== 0) {
      invalidDocx(`unsupported central entry ${index}`);
    }
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff
    ) {
      invalidDocx("ZIP64 entry");
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_DOCX_UNCOMPRESSED_BYTES) {
      tooComplex(`DOCX expands to ${totalUncompressed} bytes`);
    }
    const name = decoder
      .decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
      .replace(/\\/g, "/")
      .replace(/^\.\//, "");
    if (name === "[Content_Types].xml") hasContentTypes = true;
    if (name === "word/document.xml") hasMainDocument = true;
    offset = end;
  }

  if (offset !== centralOffset + centralSize) {
    invalidDocx("central directory size mismatch");
  }
  if (!hasContentTypes || !hasMainDocument) {
    invalidDocx("missing Word document parts");
  }
}

export function looksLikeDocxPackage(bytes: Uint8Array): boolean {
  try {
    assertSafeDocxPackage(bytes);
    return true;
  } catch {
    return false;
  }
}

function findEndOfCentralDirectory(view: DataView): number {
  const minimum = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) !== 0x06054b50) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength === view.byteLength) return offset;
  }
  return -1;
}

function invalidDocx(message: string): never {
  throw new DocumentOpenPolicyError("invalidDocx", "docx", message);
}

function tooComplex(message: string): never {
  throw new DocumentOpenPolicyError("docxTooComplex", "docx", message);
}
